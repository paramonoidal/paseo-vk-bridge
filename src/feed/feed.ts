import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { markdownToPlain } from "../vk/text.js";
import {
  type Action,
  classifyToolCall,
  type FileChange,
  fileChange,
  renderActions,
} from "./actions.js";

export interface FeedRow {
  item: AgentTimelineItem;
  turnId?: string | undefined;
}

export type TurnOutcome =
  | { kind: "completed" }
  | { kind: "failed"; error: string }
  | { kind: "canceled" };

export interface TurnFeedOptions {
  emit(text: string): void;
  /** Show action titles between the agent's messages. */
  showActions: boolean;
  /** Post pending action titles after this much silence. */
  flushAfterMs: number;
  /** True for user messages this bridge sent, which VK already shows. */
  isOwnMessage(id: string): boolean;
  now?: () => number;
}

interface AssistantDraft {
  text: string;
  messageId: string | undefined;
  turnId: string | undefined;
}

/**
 * Turns one agent's timeline into chat messages: each of the agent's own messages,
 * preceded by the titles of the actions it took since the previous one, and a short
 * summary when the turn ends. Tool output is never posted.
 */
export class TurnFeed {
  private assistant: AssistantDraft | null = null;
  private actions: Action[] = [];
  private readonly actionsById = new Map<string, Action>();
  private readonly changes = new Map<string, FileChange>();
  private turnStartedAt: number | null = null;
  private turnActive = false;
  /** When the feed last posted, so long tool runs still show progress. */
  private lastEmitAt: number;
  /** When the current message last grew, so a finished message is not held back. */
  private lastChunkAt: number;
  private readonly now: () => number;

  constructor(private readonly options: TurnFeedOptions) {
    this.now = options.now ?? Date.now;
    this.lastEmitAt = this.now();
    this.lastChunkAt = this.now();
  }

  get active(): boolean {
    return this.turnActive;
  }

  startTurn(at?: number): void {
    if (this.turnActive) return;
    this.turnActive = true;
    this.turnStartedAt = at ?? this.now();
    this.lastEmitAt = this.now();
  }

  row({ item, turnId }: FeedRow): void {
    switch (item.type) {
      case "assistant_message": {
        this.startTurn();
        this.lastChunkAt = this.now();
        const draft = this.assistant;
        const continues =
          draft !== null &&
          draft.turnId === turnId &&
          (item.messageId === undefined || draft.messageId === item.messageId);
        if (continues) {
          draft.text += item.text;
          return;
        }
        // Titles still pending belong to the actions before this message, so they
        // go out with it. A tool call always flushes the previous message first.
        if (draft !== null) this.flush();
        this.assistant = { text: item.text, messageId: item.messageId, turnId };
        return;
      }
      case "tool_call": {
        this.startTurn();
        this.flushAssistant();
        const change = fileChange(item);
        if (change) this.changes.set(item.callId, change);
        const action = classifyToolCall(item);
        const known = this.actionsById.get(item.callId);
        if (known) {
          // Later rows of the same call complete it; keep its place in the list.
          known.failed = action.failed;
          known.subject = action.subject ?? known.subject;
          known.kind = action.kind;
        } else {
          this.actionsById.set(item.callId, action);
          this.actions.push(action);
        }
        return;
      }
      case "todo":
        this.startTurn();
        this.flushAssistant();
        this.pushAction({
          id: `todo-${this.actionsById.size}`,
          kind: "todo",
          subject: null,
          failed: false,
        });
        return;
      case "compaction":
        if (item.status !== "loading") return;
        this.startTurn();
        this.flushAssistant();
        this.pushAction({
          id: `compact-${this.actionsById.size}`,
          kind: "compact",
          subject: null,
          failed: false,
        });
        return;
      case "error":
        this.flush();
        this.options.emit(`⚠️ ${item.message}`);
        return;
      case "notification":
        if (item.level === "info") return;
        this.flush();
        this.options.emit(`⚠️ ${item.message}`);
        return;
      case "user_message": {
        const id = item.clientMessageId ?? item.messageId;
        if (id !== undefined && this.options.isOwnMessage(id)) return;
        this.flush();
        this.options.emit(`👤 ${item.text}`);
        return;
      }
      case "reasoning":
        this.flushAssistant();
        return;
      case "plugin":
        return;
    }
  }

  /**
   * Posts a message the agent stopped extending, and action titles that have waited
   * since the last post, so a long run of tool calls still shows progress.
   */
  tick(): void {
    const now = this.now();
    const wait = this.options.flushAfterMs;
    if (this.assistant !== null) {
      if (now - this.lastChunkAt >= wait) this.flush();
      return;
    }
    if (this.options.showActions && this.actions.length > 0 && now - this.lastEmitAt >= wait) {
      this.flush();
    }
  }

  endTurn(outcome: TurnOutcome, at?: number): void {
    const idle = !this.turnActive && this.assistant === null && this.actions.length === 0;
    // A turn already closed by catch-up, or one this feed never saw, has nothing to report.
    if (idle && outcome.kind !== "failed") return;
    const body = this.compose();
    const footer = this.footer(outcome, at ?? this.now());
    this.options.emit(body ? `${body}\n\n${footer}` : footer);
    this.assistant = null;
    this.actions = [];
    this.actionsById.clear();
    this.changes.clear();
    this.turnActive = false;
    this.turnStartedAt = null;
    this.lastEmitAt = this.now();
  }

  /** Emits everything pending: action titles, then the agent's message. */
  flush(): void {
    const text = this.compose();
    this.assistant = null;
    this.actions = [];
    if (text) {
      this.lastEmitAt = this.now();
      this.options.emit(text);
    }
  }

  private flushAssistant(): void {
    if (this.assistant !== null) this.flush();
  }

  private pushAction(action: Action): void {
    this.actionsById.set(action.id, action);
    this.actions.push(action);
  }

  private compose(): string {
    const parts: string[] = [];
    if (this.options.showActions && this.actions.length > 0) {
      parts.push(renderActions(this.actions).join("\n"));
    }
    const text = this.assistant ? markdownToPlain(this.assistant.text) : "";
    if (text) parts.push(text);
    return parts.join("\n\n");
  }

  private footer(outcome: TurnOutcome, endedAt: number): string {
    const duration =
      this.turnStartedAt === null ? null : formatDuration(endedAt - this.turnStartedAt);
    const changes = summarizeChanges([...this.changes.values()]);
    switch (outcome.kind) {
      case "completed":
        return `✅ Done${duration ? ` in ${duration}` : ""}${changes ? ` · ${changes}` : ""}`;
      case "canceled":
        return `⏹ Stopped${duration ? ` after ${duration}` : ""}${changes ? ` · ${changes}` : ""}`;
      case "failed":
        return `❌ Failed${duration ? ` after ${duration}` : ""}: ${outcome.error}`;
    }
  }
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** "2 files changed +93 −4" over the turn's edits, counting each file once. */
export function summarizeChanges(changes: readonly FileChange[]): string | null {
  if (changes.length === 0) return null;
  const files = new Set(changes.map((change) => change.path));
  const added = changes.reduce((sum, change) => sum + change.added, 0);
  const removed = changes.reduce((sum, change) => sum + change.removed, 0);
  return `${files.size} ${files.size === 1 ? "file" : "files"} changed +${added} −${removed}`;
}
