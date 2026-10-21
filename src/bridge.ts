import type { PaseoAgent, PaseoAgentHandle } from "@getpaseo/client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { BridgeConfig } from "./config.js";
import { formatDuration } from "./feed/feed.js";
import { AnswerError, allowResponse, answerPermission, denyResponse } from "./feed/permissions.js";
import { AgentWatcher } from "./feed/watcher.js";
import { errorMessage, type Logger } from "./log.js";
import type { NodeRegistry, PaseoNode } from "./paseo/nodes.js";
import { ProviderUnavailableError, resolveAgentConfig } from "./paseo/providers.js";
import type { StateStore } from "./store.js";
import { type Transcriber, TranscriptionError } from "./transcribe/index.js";
import { AttachmentTooLargeError, type VkApi } from "./vk/api.js";
import { commandKeyboard } from "./vk/keyboard.js";
import { isDirectMessage, parseMessageNew, type VkInboundMessage } from "./vk/message.js";
import type { SendOptions, VkOutbox } from "./vk/outbox.js";
import { markdownToPlain } from "./vk/text.js";

/** Prefix of the message IDs this bridge gives prompts; the feed skips their echoes. */
const OWN_MESSAGE_PREFIX = "vk:";
const LIST_LIMIT = 12;

export const HELP = [
  "Messages go to the agent on the current node.",
  "",
  "/nodes — nodes and their status",
  "/node <name> — switch node",
  "/agents — recent agents · /use <n> — switch to one",
  "/projects — projects on the node",
  "/new [provider] [n | /path] — start a new agent",
  "/stop — stop the current turn",
  "/status — node and agent details",
  "/mode [id] · /model [id] — show or change",
  "/allow [n] · /deny [reason] — answer a pending request",
  "/archive — archive the current agent",
  "",
  "Photos and documents go to the agent. Voice messages are transcribed.",
  "Start a message with // to send a slash command to the agent itself.",
].join("\n");

/** An error whose message is meant for the person in the chat. */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}

function isUserFacing(error: unknown): error is Error {
  return (
    error instanceof UserError ||
    error instanceof ProviderUnavailableError ||
    error instanceof AnswerError ||
    error instanceof TranscriptionError ||
    error instanceof AttachmentTooLargeError
  );
}

export interface BridgeDeps {
  config: BridgeConfig;
  vk: VkApi;
  outbox: VkOutbox;
  store: StateStore;
  nodes: NodeRegistry;
  transcriber: Transcriber | null;
  logger: Logger;
}

interface Listing {
  node: string;
  ids: string[];
}

export class Bridge {
  private readonly watchers = new Map<number, AgentWatcher>();
  private readonly watcherOps = new Map<number, Promise<unknown>>();
  private readonly agentListings = new Map<number, Listing>();
  private readonly projectListings = new Map<number, Listing>();
  private unsubscribeNodes: (() => void) | null = null;

  constructor(private readonly deps: BridgeDeps) {}

  /** Resumes following each chat's agent once its node is connected. */
  start(): void {
    this.unsubscribeNodes = this.deps.nodes.onStatusChange((node, status) => {
      if (status !== "connected") return;
      for (const { peerId } of this.deps.store.chats()) {
        if (this.currentNodeName(peerId) === node.name) void this.ensureWatcher(peerId);
      }
    });
    for (const { peerId } of this.deps.store.chats()) void this.ensureWatcher(peerId);
  }

  async stop(): Promise<void> {
    this.unsubscribeNodes?.();
    await Promise.all([...this.watcherOps.values()].map((op) => op.catch(() => {})));
    await Promise.all([...this.watchers.values()].map((watcher) => watcher.stop()));
    this.watchers.clear();
  }

  /** Handles one journaled Long Poll event. */
  async handleEvent(event: unknown): Promise<void> {
    const message = this.accept(event);
    if (!message) return;
    try {
      await this.dispatch(message);
    } catch (error) {
      if (!isUserFacing(error)) {
        this.deps.logger.error("message handling failed", {
          peerId: message.peerId,
          error: errorMessage(error),
        });
      }
      await this.reply(message.peerId, `⚠️ ${errorMessage(error)}`);
    }
  }

  /** Reports a message that was mid-dispatch when the bridge stopped. */
  async handleInterrupted(event: unknown): Promise<void> {
    const message = this.accept(event, { quiet: true });
    if (!message) return;
    await this.reply(
      message.peerId,
      "⚠️ The bridge restarted while handling this message, so it may not have reached the agent. Check /status before sending it again.",
      { replyTo: message.id },
    );
  }

  private accept(event: unknown, options: { quiet?: boolean } = {}): VkInboundMessage | null {
    const message = parseMessageNew(event, this.deps.vk.groupId);
    if (!message || !isDirectMessage(message)) return null;
    if (this.deps.config.vk.allowlist.includes(message.fromId)) return message;
    this.deps.logger.warn("message from a user outside the allowlist", { fromId: message.fromId });
    if (!options.quiet) {
      void this.deps.outbox.send(
        message.peerId,
        `Access is restricted. Your VK user ID is ${message.fromId}; add it to vk.allowlist to use this bridge.`,
      );
    }
    return null;
  }

  private async dispatch(message: VkInboundMessage): Promise<void> {
    const text = message.text.trim();
    if (message.payload?.includes('"start"')) return this.reply(message.peerId, HELP);
    if (text.startsWith("/") && !text.startsWith("//")) return this.command(message, text);
    const hasMedia =
      message.photos.length > 0 || message.documents.length > 0 || message.voice !== null;
    const pending = this.watchers.get(message.peerId)?.pendingPermissions()[0];
    if (pending && text && !hasMedia) {
      const response = answerPermission(pending, text);
      await this.respond(message.peerId, pending.id, response);
      return;
    }
    await this.prompt(message, text.startsWith("//") ? text.slice(1) : text);
  }

  // ── Prompts ──────────────────────────────────────────────────────────────

  private async prompt(message: VkInboundMessage, text: string): Promise<void> {
    const peerId = message.peerId;
    const node = this.connectedNode(peerId);
    const content = await this.collect(message, node, text);
    let agentId = this.boundAgentId(peerId, node.name);
    if (!agentId) agentId = (await this.createAgent(peerId, node, {})).id;
    await this.ensureWatcher(peerId);
    this.deps.outbox.typing(peerId);
    try {
      await node.api.agents.ref(agentId).send(content.text, {
        messageId: `${OWN_MESSAGE_PREFIX}${peerId}:${message.id}`,
        activeTurnBehavior: this.deps.config.defaults.busy,
        ...(content.images.length > 0 ? { images: content.images } : {}),
        ...(content.attachments.length > 0 ? { attachments: content.attachments } : {}),
      });
    } catch (error) {
      if (/not found|unknown agent|no agent/i.test(errorMessage(error))) {
        await this.bind(peerId, node.name, null);
        throw new UserError(
          "That agent no longer exists. Send the message again to start a new one, or pick one with /agents.",
        );
      }
      throw error;
    }
  }

  private async collect(message: VkInboundMessage, node: PaseoNode, text: string) {
    const limit = this.deps.config.vk.attachmentLimitMb * 1024 * 1024;
    const parts: string[] = [];
    if (text) parts.push(text);
    if (message.voice) {
      const transcript = await this.transcribe(message, limit);
      await this.reply(message.peerId, `🎤 ${transcript}`);
      parts.push(transcript);
    }
    if (message.quoted.length > 0) {
      const quotes = message.quoted.map((quote) =>
        quote
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n"),
      );
      parts.push(`Quoted messages:\n${quotes.join("\n\n")}`);
    }

    const images: Array<{ data: string; mimeType: string }> = [];
    for (const photo of message.photos) {
      const file = await this.deps.vk.download(photo.url, limit);
      images.push({
        data: Buffer.from(file.bytes).toString("base64"),
        mimeType: file.contentType?.startsWith("image/")
          ? file.contentType.split(";")[0]!
          : "image/jpeg",
      });
    }

    const attachments: Array<Awaited<ReturnType<typeof node.client.uploadFile>>["file"] & object> =
      [];
    for (const document of message.documents) {
      const file = await this.deps.vk.download(document.url, limit);
      const uploaded = await node.client.uploadFile({
        fileName: document.title,
        mimeType: file.contentType?.split(";")[0] || "application/octet-stream",
        bytes: file.bytes,
      });
      if (!uploaded.file) throw new Error(`upload of ${document.title} failed: ${uploaded.error}`);
      attachments.push(uploaded.file);
    }

    if (message.unsupported.length > 0) {
      await this.reply(
        message.peerId,
        `Skipped attachments the agent cannot read: ${[...new Set(message.unsupported)].join(", ")}.`,
      );
    }
    if (parts.length === 0 && images.length === 0 && attachments.length === 0) {
      throw new UserError("Send text, a photo, a document or a voice message.");
    }
    const fallback = images.length > 0 ? "See the attached image." : "See the attached file.";
    return { text: parts.join("\n\n") || fallback, images, attachments };
  }

  private async transcribe(message: VkInboundMessage, limit: number): Promise<string> {
    const voice = message.voice;
    if (!voice) return "";
    let transcript: string;
    if (this.deps.transcriber) {
      this.deps.outbox.typing(message.peerId);
      const audio = await this.deps.vk.download(voice.url, limit);
      transcript = await this.deps.transcriber.transcribe({
        bytes: audio.bytes,
        fileName: voice.mimeType === "audio/ogg" ? "voice.ogg" : "voice.mp3",
        mimeType: voice.mimeType,
      });
    } else if (voice.vkTranscript) {
      transcript = voice.vkTranscript;
    } else {
      throw new UserError(
        "Voice messages need transcription. Configure `transcription` for the bridge.",
      );
    }
    if (!transcript.trim()) throw new UserError("No speech was recognized in the voice message.");
    return transcript.trim();
  }

  // ── Commands ─────────────────────────────────────────────────────────────

  private async command(message: VkInboundMessage, text: string): Promise<void> {
    const peerId = message.peerId;
    const [rawName = ""] = text.slice(1).split(/\s+/, 1);
    const name = rawName.toLowerCase().replace(/@.*$/, "");
    const args = text.slice(1 + rawName.length).trim();
    switch (name) {
      case "help":
      case "start":
        return this.reply(peerId, HELP);
      case "nodes":
        return this.reply(peerId, this.describeNodes(peerId));
      case "node":
        return args
          ? this.switchNode(peerId, args)
          : this.reply(peerId, this.describeNodes(peerId));
      case "projects":
        return this.listProjects(peerId);
      case "new":
        return this.newAgent(peerId, args);
      case "agents":
        return this.listAgents(peerId);
      case "use":
        return this.useAgent(peerId, args);
      case "stop":
        return this.stopTurn(peerId);
      case "status":
        return this.status(peerId);
      case "mode":
        return this.mode(peerId, args);
      case "model":
        return this.model(peerId, args);
      case "allow":
        return this.allow(peerId, args);
      case "deny":
        return this.deny(peerId, args);
      case "archive":
        return this.archive(peerId);
      default:
        throw new UserError(
          `Unknown command /${name}. Send /help for the list, or //${name} to send it to the agent.`,
        );
    }
  }

  private describeNodes(peerId: number): string {
    const current = this.currentNodeName(peerId);
    const lines = this.deps.nodes.list().map((node) => {
      const status = node.status();
      const icon = status === "connected" ? "🟢" : status === "connecting" ? "🟡" : "🔴";
      const host = node.hostname();
      const detail =
        status === "connected"
          ? [host, node.via].filter(Boolean).join(" · ")
          : `${status}${node.lastError() ? `: ${node.lastError()}` : ""}`;
      return `${icon} ${node.name} — ${detail}${node.name === current ? "  ← current" : ""}`;
    });
    return [...lines, "", "Switch with /node <name>."].join("\n");
  }

  private async switchNode(peerId: number, name: string): Promise<void> {
    const node = this.deps.nodes.get(name);
    if (!node) {
      throw new UserError(`No node named ${name}. Nodes: ${this.deps.nodes.names().join(", ")}.`);
    }
    await this.deps.store.updateChat(peerId, (chat) => ({ ...chat, node: node.name }));
    await this.ensureWatcher(peerId);
    const agentId = this.boundAgentId(peerId, node.name);
    const agent =
      agentId && node.status() === "connected" ? await this.snapshot(node, agentId) : null;
    const next = agent
      ? `Agent: ${agentTitle(agent)} (${agent.status}).`
      : node.config.cwd
        ? `Your next message starts an agent in ${node.config.cwd}.`
        : "Start an agent with /projects and /new <number>.";
    await this.reply(
      peerId,
      `Switched to ${node.name}${node.status() === "connected" ? "" : ` (${node.status()})`}. ${next}`,
    );
  }

  private async listProjects(peerId: number): Promise<void> {
    const node = this.connectedNode(peerId);
    const { projects } = await node.api.projects.list();
    if (projects.length === 0) {
      throw new UserError(`No projects on ${node.name}. Start one with /new /absolute/path.`);
    }
    const shown = projects.slice(0, 20);
    this.projectListings.set(peerId, { node: node.name, ids: shown.map((p) => p.projectRootPath) });
    const lines = shown.map(
      (project, index) =>
        `${index + 1}. ${project.projectCustomName ?? project.projectDisplayName} — ${project.projectRootPath}`,
    );
    await this.reply(
      peerId,
      [`📁 Projects on ${node.name}:`, ...lines, "", "Start an agent with /new <number>."].join(
        "\n",
      ),
    );
  }

  private async newAgent(peerId: number, args: string): Promise<void> {
    const node = this.connectedNode(peerId);
    let provider: string | undefined;
    let cwd: string | undefined;
    for (const token of args.split(/\s+/).filter(Boolean)) {
      if (/^\d+$/.test(token)) {
        const listing = this.projectListings.get(peerId);
        const path = listing?.node === node.name ? listing.ids[Number(token) - 1] : undefined;
        if (!path) throw new UserError(`No project ${token}. List them with /projects.`);
        cwd = path;
      } else if (/^(\/|[A-Za-z]:[\\/])/.test(token)) {
        cwd = token;
      } else if (token.startsWith("~")) {
        throw new UserError("Use an absolute path; ~ is not expanded on the node.");
      } else {
        provider = token;
      }
    }
    await this.createAgent(peerId, node, {
      ...(provider ? { provider } : {}),
      ...(cwd ? { cwd } : {}),
    });
  }

  private async createAgent(
    peerId: number,
    node: PaseoNode,
    options: { provider?: string; cwd?: string },
  ): Promise<PaseoAgentHandle> {
    const cwd = options.cwd ?? node.config.cwd;
    if (!cwd) {
      throw new UserError(
        `No working directory for ${node.name}. Use /projects and /new <number>, /new /absolute/path, or set nodes.${node.name}.cwd.`,
      );
    }
    const resolved = await resolveAgentConfig(node.api, {
      provider: options.provider ?? node.config.provider ?? this.deps.config.defaults.provider,
      cwd,
      modes: this.deps.config.defaults.modes,
    });
    const handle = await node.api.agents.create({
      config: {
        provider: resolved.provider,
        ...(resolved.modeId ? { modeId: resolved.modeId } : {}),
      },
      cwd,
      labels: { source: "vk-bridge" },
    });
    await this.bind(peerId, node.name, handle.id);
    await this.reply(
      peerId,
      `🆕 New ${resolved.label} agent · ${resolved.model}${resolved.modeId ? ` · ${resolved.modeId}` : ""}\n📁 ${cwd}`,
    );
    return handle;
  }

  private async listAgents(peerId: number): Promise<void> {
    const node = this.connectedNode(peerId);
    const result = await node.api.agents.list({
      sort: [{ key: "updated_at", direction: "desc" }],
      page: { limit: LIST_LIMIT },
    });
    if (result.entries.length === 0) {
      throw new UserError(`No agents on ${node.name} yet. Send a message or use /new.`);
    }
    const current = this.boundAgentId(peerId, node.name);
    this.agentListings.set(peerId, { node: node.name, ids: result.entries.map((e) => e.agent.id) });
    const lines = result.entries.map(({ agent }, index) => {
      const marker = agent.id === current ? "  ← current" : "";
      return `${index + 1}. ${statusIcon(agent)} ${agentTitle(agent)} — ${agent.provider} · ${shortPath(agent.cwd)}${marker}`;
    });
    await this.reply(
      peerId,
      [`🤖 Agents on ${node.name}:`, ...lines, "", "Switch with /use <number>."].join("\n"),
    );
  }

  private async useAgent(peerId: number, args: string): Promise<void> {
    const node = this.connectedNode(peerId);
    if (!args) throw new UserError("Use /use <number> after /agents, or /use <agent id>.");
    let agentId = args;
    if (/^\d+$/.test(args)) {
      const listing = this.agentListings.get(peerId);
      const id = listing?.node === node.name ? listing.ids[Number(args) - 1] : undefined;
      if (!id) throw new UserError(`No agent ${args}. List them with /agents.`);
      agentId = id;
    }
    const agent = await this.snapshot(node, agentId);
    if (!agent) throw new UserError(`No agent ${args} on ${node.name}.`);
    await this.bind(peerId, node.name, agent.id);
    await this.ensureWatcher(peerId);
    const last = await this.lastAssistantMessage(node, agent.id);
    await this.reply(
      peerId,
      `Switched to ${agentTitle(agent)} (${agent.provider}, ${agent.status}).${last ? `\n\nLast message:\n${last}` : ""}`,
    );
  }

  private async stopTurn(peerId: number): Promise<void> {
    const { node, agentId } = this.requireAgent(peerId);
    const agent = await this.snapshot(node, agentId);
    if (agent?.status !== "running") return this.reply(peerId, "Nothing is running.");
    await node.client.cancelAgent(agentId);
  }

  private async status(peerId: number): Promise<void> {
    const node = this.currentNode(peerId);
    const nodeLine = `🖥 ${node.name} — ${node.status()}${node.hostname() ? ` · ${node.hostname()}` : ""} · ${node.via}`;
    const agentId = this.boundAgentId(peerId, node.name);
    if (!agentId || node.status() !== "connected") {
      const hint = agentId
        ? ""
        : `\nNo agent yet. ${node.config.cwd ? `Your next message starts one in ${node.config.cwd}.` : "Start one with /new."}`;
      return this.reply(peerId, `${nodeLine}${hint}`);
    }
    const agent = await this.snapshot(node, agentId);
    if (!agent) {
      await this.bind(peerId, node.name, null);
      return this.reply(
        peerId,
        `${nodeLine}\nThe bound agent no longer exists. Your next message starts a new one.`,
      );
    }
    const lines = [
      nodeLine,
      `🤖 ${agentTitle(agent)} · ${statusIcon(agent)} ${agent.status}`,
      `${agent.provider}${agent.model ? `/${agent.model}` : ""}${agent.currentModeId ? ` · ${agent.currentModeId}` : ""}`,
      `📁 ${agent.cwd}`,
    ];
    if (agent.activeTurn) {
      const startedAt = Date.parse(agent.activeTurn.startedAt ?? "");
      lines.push(
        Number.isNaN(startedAt)
          ? "⏳ Working"
          : `⏳ Working for ${formatDuration(Date.now() - startedAt)}`,
      );
    }
    if (agent.pendingPermissions.length > 0) {
      lines.push(`❓ ${agent.pendingPermissions.length} request(s) waiting for an answer`);
    }
    if (agent.lastError) lines.push(`⚠️ ${agent.lastError}`);
    await this.reply(peerId, lines.join("\n"));
  }

  private async mode(peerId: number, args: string): Promise<void> {
    const { node, agentId } = this.requireAgent(peerId);
    const agent = await this.snapshot(node, agentId);
    if (!agent) throw new UserError("The agent no longer exists.");
    if (!args) {
      const lines = agent.availableModes.map(
        (mode) =>
          `• ${mode.id}${mode.label && mode.label !== mode.id ? ` — ${mode.label}` : ""}${mode.id === agent.currentModeId ? "  ← current" : ""}`,
      );
      return this.reply(
        peerId,
        lines.length > 0
          ? [...lines, "", "Change with /mode <id>."].join("\n")
          : "This agent has no modes.",
      );
    }
    const wanted = args.toLowerCase();
    const mode = agent.availableModes.find(
      (candidate) =>
        candidate.id.toLowerCase() === wanted || candidate.label?.toLowerCase() === wanted,
    );
    if (!mode) throw new UserError(`No mode ${args}. See /mode.`);
    await node.client.setAgentMode(agentId, mode.id);
    await this.reply(peerId, `Mode: ${mode.id}`);
  }

  private async model(peerId: number, args: string): Promise<void> {
    const { node, agentId } = this.requireAgent(peerId);
    const agent = await this.snapshot(node, agentId);
    if (!agent) throw new UserError("The agent no longer exists.");
    if (!args) {
      const { models = [] } = await node.api.providers.listModels(agent.provider, {
        cwd: agent.cwd,
      });
      const lines = models
        .filter((model) => model.isSelectable !== false)
        .slice(0, 25)
        .map(
          (model) =>
            `• ${model.id}${model.label !== model.id ? ` — ${model.label}` : ""}${model.id === agent.model ? "  ← current" : ""}`,
        );
      return this.reply(peerId, [...lines, "", "Change with /model <id>."].join("\n"));
    }
    await node.client.setAgentModel(agentId, args);
    await this.reply(peerId, `Model: ${args}`);
  }

  private async allow(peerId: number, args: string): Promise<void> {
    const request = this.requirePending(peerId);
    if (request.kind === "question") {
      throw new UserError("Answer the question with an option number or your own text.");
    }
    const choice = /^\d+$/.test(args) ? Number(args) : undefined;
    await this.respond(peerId, request.id, allowResponse(request, choice));
  }

  private async deny(peerId: number, args: string): Promise<void> {
    const request = this.requirePending(peerId);
    await this.respond(peerId, request.id, denyResponse(args));
  }

  private async archive(peerId: number): Promise<void> {
    const { node, agentId } = this.requireAgent(peerId);
    await node.api.agents.ref(agentId).archive();
    await this.bind(peerId, node.name, null);
    await this.reply(peerId, "🗄 Archived. Your next message starts a new agent.");
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async respond(
    peerId: number,
    requestId: string,
    response: Parameters<PaseoAgentHandle["respondToPermission"]>[0]["response"],
  ): Promise<void> {
    const watcher = this.watchers.get(peerId);
    if (!watcher) throw new UserError("Nothing is waiting for an answer.");
    await watcher.node.api.agents.ref(watcher.agentId).respondToPermission({ requestId, response });
    watcher.resolved(requestId);
    await this.reply(peerId, response.behavior === "allow" ? "✔ Sent." : "✖ Declined.");
  }

  private requirePending(peerId: number) {
    const request = this.watchers.get(peerId)?.pendingPermissions()[0];
    if (!request) throw new UserError("Nothing is waiting for an answer.");
    return request;
  }

  private currentNodeName(peerId: number): string {
    const chosen = this.deps.store.chat(peerId).node;
    if (chosen && this.deps.nodes.get(chosen)) return chosen;
    return this.deps.config.defaults.node ?? this.deps.nodes.names()[0] ?? "";
  }

  private currentNode(peerId: number): PaseoNode {
    const node = this.deps.nodes.get(this.currentNodeName(peerId));
    if (!node) throw new UserError("No nodes are configured.");
    return node;
  }

  private connectedNode(peerId: number): PaseoNode {
    const node = this.currentNode(peerId);
    if (node.status() !== "connected") {
      throw new UserError(
        `📴 ${node.name} is ${node.status()}${node.lastError() ? ` (${node.lastError()})` : ""}. See /nodes.`,
      );
    }
    return node;
  }

  private boundAgentId(peerId: number, nodeName: string): string | undefined {
    return this.deps.store.chat(peerId).agents[nodeName];
  }

  private requireAgent(peerId: number): { node: PaseoNode; agentId: string } {
    const node = this.connectedNode(peerId);
    const agentId = this.boundAgentId(peerId, node.name);
    if (!agentId) throw new UserError("No agent yet. Send a message or use /new.");
    return { node, agentId };
  }

  private async bind(peerId: number, nodeName: string, agentId: string | null): Promise<void> {
    await this.deps.store.updateChat(peerId, (chat) => {
      const agents = { ...chat.agents };
      if (agentId) agents[nodeName] = agentId;
      else delete agents[nodeName];
      return { node: nodeName, agents };
    });
    await this.ensureWatcher(peerId);
  }

  private async snapshot(node: PaseoNode, agentId: string): Promise<PaseoAgent | null> {
    return (await node.api.agents.ref(agentId).refresh())?.agent ?? null;
  }

  private async lastAssistantMessage(node: PaseoNode, agentId: string): Promise<string | null> {
    try {
      const page = await node.api.agents.ref(agentId).timeline.refetch({
        direction: "tail",
        limit: 40,
        projection: "projected",
      });
      const item = [...page.entries]
        .reverse()
        .map((entry) => entry.item as AgentTimelineItem)
        .find((candidate) => candidate.type === "assistant_message");
      if (item?.type !== "assistant_message") return null;
      const text = markdownToPlain(item.text);
      const chars = Array.from(text);
      return chars.length > 1500 ? `…${chars.slice(-1500).join("")}` : text;
    } catch {
      return null;
    }
  }

  /** Follows the chat's agent on its current node, replacing any previous watcher. */
  private ensureWatcher(peerId: number): Promise<AgentWatcher | null> {
    const previous = this.watcherOps.get(peerId) ?? Promise.resolve();
    const op = previous.catch(() => {}).then(() => this.replaceWatcher(peerId));
    this.watcherOps.set(peerId, op);
    void op.finally(() => {
      if (this.watcherOps.get(peerId) === op) this.watcherOps.delete(peerId);
    });
    return op;
  }

  private async replaceWatcher(peerId: number): Promise<AgentWatcher | null> {
    const nodeName = this.currentNodeName(peerId);
    const node = this.deps.nodes.get(nodeName);
    const agentId = this.boundAgentId(peerId, nodeName);
    const existing = this.watchers.get(peerId);
    if (existing && existing.node.name === nodeName && existing.agentId === agentId)
      return existing;
    if (existing) {
      this.watchers.delete(peerId);
      await existing.stop();
    }
    if (!node || !agentId || node.status() !== "connected") return null;
    const watcher = new AgentWatcher({
      node,
      agentId,
      store: this.deps.store,
      sink: {
        send: (text, options) => this.deps.outbox.send(peerId, text, options),
        typing: () => this.deps.outbox.typing(peerId),
      },
      logger: this.deps.logger.child({ node: node.name, agentId, peerId }),
      showActions: this.deps.config.feed.actions,
      flushAfterMs: this.deps.config.feed.flushAfterSeconds * 1000,
      ownMessagePrefix: OWN_MESSAGE_PREFIX,
    });
    this.watchers.set(peerId, watcher);
    await watcher.start();
    return watcher;
  }

  private reply(peerId: number, text: string, options: SendOptions = {}): Promise<void> {
    return this.deps.outbox.send(peerId, text, { keyboard: commandKeyboard(), ...options });
  }
}

function agentTitle(agent: { title: string | null; id: string }): string {
  return agent.title?.trim() || `Agent ${agent.id.slice(0, 8)}`;
}

function statusIcon(agent: Pick<PaseoAgent, "status" | "pendingPermissions">): string {
  if (agent.pendingPermissions?.length) return "❓";
  switch (agent.status) {
    case "running":
      return "⏳";
    case "idle":
      return "💬";
    case "initializing":
      return "…";
    case "error":
      return "❌";
    case "closed":
      return "⏹";
  }
}

function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`;
}
