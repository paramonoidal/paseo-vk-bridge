/**
 * Drives the real bridge against a real Paseo daemon and a fake VK server.
 * The daemon must run in development mode so its `mock` provider is available:
 *
 *   scripts/dev-daemon.sh            # prints PASEO_E2E_DAEMON and PASEO_E2E_CWD
 *   PASEO_E2E_DAEMON=127.0.0.1:7788 PASEO_E2E_CWD=/path/to/repo npm run test:e2e
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RunningApp, startApp } from "../app.js";
import { type BridgeConfig, parseConfig } from "../config.js";
import { createLogger, silentLogger } from "../log.js";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { FakeVk, type SentMessage } from "../test-support/fake-vk.js";
import { markdownToPlain } from "../vk/text.js";

const DAEMON = process.env.PASEO_E2E_DAEMON;
const CWD = process.env.PASEO_E2E_CWD;
const USER = 4242;
const GROUP = 77;
const TURN_TIMEOUT = 60_000;

const logger = process.env.PASEO_E2E_DEBUG ? createLogger({ level: "debug" }) : silentLogger;

async function until(condition: () => boolean, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  expect(condition()).toBe(true);
}

const CHROME = /^(💻|📄|🖼|✏️|📝|🔍|🌐|🤖|📋|🗜|🌿|🔧|✅|⏹|❌|⚠️|🆕|📁|✔|✖|👤)/u;

/** Action titles, footers and bridge notices, as opposed to the agent's own words. */
function isChrome(paragraph: string): boolean {
  return paragraph.split("\n").every((line) => CHROME.test(line));
}

function squash(text: string): string {
  return text.replace(/\s+/g, "");
}

function labels(message: SentMessage): string[] {
  return message.keyboard?.buttons.flat().map((button) => button.action.label) ?? [];
}

describe.skipIf(!DAEMON || !CWD)("bridge against a Paseo daemon", () => {
  const vk = new FakeVk(GROUP);
  let config: BridgeConfig;
  let app: RunningApp;

  async function start() {
    app = await startApp(config, logger, {
      vk: {
        apiBaseUrl: `${vk.baseUrl}/method`,
        trustHost: (host) => host === "127.0.0.1",
        allowHttp: true,
        minRequestIntervalMs: 0,
      },
      pollWaitSeconds: 1,
    });
    await until(() => app.nodes.get("dev")?.status() === "connected");
  }

  /** Sends a message and returns everything the bridge posts until `done` matches. */
  async function exchange(text: string, done: (m: SentMessage) => boolean, extra = {}) {
    const from = vk.sent.length;
    const finished = vk.next(done, TURN_TIMEOUT);
    vk.receive(USER, text, extra);
    await finished;
    return vk.sent.slice(from);
  }

  beforeAll(async () => {
    await vk.start();
    const stateDir = await mkdtemp(path.join(tmpdir(), "vk-bridge-e2e-"));
    config = parseConfig(
      {
        vk: { token: "token", groupId: GROUP, allowlist: [USER] },
        nodes: { dev: { url: DAEMON, cwd: CWD, provider: "mock/ten-second-stream" } },
        feed: { flushAfterSeconds: 5 },
        transcription: {
          kind: "command",
          command: [process.execPath, "-e", "process.stdout.write('voice says hello')", "{file}"],
        },
        stateFile: path.join(stateDir, "state.json"),
      },
      {},
    );
    await start();
  }, 30_000);

  afterAll(async () => {
    await app?.stop();
    await vk.stop();
    if (process.env.PASEO_E2E_TRANSCRIPT) {
      await writeFile(process.env.PASEO_E2E_TRANSCRIPT, vk.transcript());
    }
  });

  it("answers /help and /nodes with the command keyboard", async () => {
    const [help] = await exchange("/help", (m) => m.text.includes("/nodes"));
    expect(labels(help!)).toEqual(["/stop", "/status", "/agents", "/new", "/nodes", "/help"]);
    const [nodes] = await exchange("/nodes", (m) => m.text.includes("← current"));
    expect(nodes!.text).toMatch(/^🟢 dev — .*127\.0\.0\.1:\d+ {2}← current/);
  });

  it("starts an agent and posts its messages with action titles, never tool output", async () => {
    const feed = await exchange("Investigate the scroll anchor", (m) =>
      m.text.includes("✅ Done in"),
    );
    const texts = feed.map((m) => m.text);
    expect(texts[0]).toMatch(/^🆕 New Mock Load Test agent · ten-second-stream\n📁 /);
    const all = texts.join("\n---\n");
    expect(all).toContain("📄 Read conversation-list.tsx\n🔍 Searched for “scrollToEnd”\n\n");
    expect(all).toContain(
      "✏️ Edited use-scroll-anchor.ts\n💻 Ran node scripts/simulate-stream-burst.mjs\n\n",
    );
    expect(texts.at(-1)).toMatch(/✅ Done in \d+s · 1 file changed \+\d+ −\d+$/);
    expect(all).not.toContain("[burst] tick");
    expect(all).not.toContain("👤");
    expect(vk.typing).toBeGreaterThan(0);
  });

  it("reports node and agent details with /status", async () => {
    const [status] = await exchange("/status", (m) => m.text.startsWith("🖥 dev"));
    expect(status!.text).toMatch(/🤖 .* · 💬 idle\nmock\/ten-second-stream/);
    expect(status!.text).toContain(`📁 ${CWD}`);
  });

  it("asks for plan approval with buttons and passes the choice back", async () => {
    const [prompt] = await exchange("emit synthetic plan approval", (m) => m.text.startsWith("🔐"));
    expect(prompt!.text).toContain("Review the proposed plan");
    expect(prompt!.text).toContain('2. Run --name="my repo".');
    expect(labels(prompt!)).toEqual(["1. Implement", "2. Dismiss"]);
    const after = await exchange("1. Implement", (m) => m.text.includes("✅ Done"));
    expect(after[0]?.text).toBe("✔ Sent.");
    expect(after.at(-1)?.text).toMatch(/^✅ Done in \d+s$/);
    const [status] = await exchange("/status", (m) => m.text.startsWith("🖥 dev"));
    expect(status!.text).not.toContain("❓");
  });

  it("asks questions and sends the answers", async () => {
    const [prompt] = await exchange("emit synthetic questions", (m) => m.text.startsWith("❓"));
    expect(prompt!.text).toContain("❓ 1) Which surface should this apply to?\n1. App\n2. Desktop");
    expect(prompt!.text).toContain("Answer each question on its own line");
    const after = await exchange("2\n1\nNo scroll jumps", (m) => m.text.includes("✅ Done"));
    expect(after[0]?.text).toBe("✔ Sent.");
    expect(after.at(-1)?.text).toMatch(/^✅ Done in \d+s$/);
  });

  it("reports a failed turn", async () => {
    const feed = await exchange("emit synthetic turn failure", (m) => m.text.includes("❌ Failed"));
    expect(feed.at(-1)?.text).toMatch(/❌ Failed after \d+s: /);
  });

  it("stops a running turn with /stop", async () => {
    const stopped = vk.next((m) => m.text.includes("⏹ Stopped after"), TURN_TIMEOUT);
    vk.receive(USER, "Start a long investigation");
    await vk.next((m) => m.text.length > 0 && !m.text.startsWith("✔"));
    vk.receive(USER, "/stop");
    await stopped;
  });

  it("transcribes a voice message and sends the transcript", async () => {
    const url = vk.hostFile("voice.ogg", "audio/ogg", Buffer.from("OggS fake audio"));
    const feed = await exchange("", (m) => m.text.includes("✅ Done"), {
      attachments: [{ type: "audio_message", audio_message: { link_ogg: url, duration: 2 } }],
    });
    expect(feed[0]?.text).toBe("🎤 voice says hello");
  });

  it("passes photos and documents to the agent", async () => {
    const photo = vk.hostFile("shot.png", "image/png", Buffer.from("89504e470d0a1a0a", "hex"));
    const doc = vk.hostFile("notes.txt", "text/plain", Buffer.from("remember the anchor\n"));
    const feed = await exchange(
      "Look at these",
      (m) => m.text.includes("✅ Done") || m.text.startsWith("⚠️"),
      {
        attachments: [
          { type: "photo", photo: { sizes: [{ url: photo, width: 1, height: 1 }] } },
          { type: "doc", doc: { url: doc, title: "notes.txt", size: 20 } },
        ],
      },
    );
    expect(feed.map((m) => m.text).join("\n")).not.toContain("⚠️");
  });

  it("lists agents, starts another, and switches back", async () => {
    const [list] = await exchange("/agents", (m) => m.text.startsWith("🤖 Agents on dev"));
    expect(list!.text).toMatch(/1\. .* — mock · .*← current/);
    const [created] = await exchange("/new", (m) => m.text.startsWith("🆕"));
    expect(created!.text).toContain("ten-second-stream");
    const [again] = await exchange("/agents", (m) => m.text.startsWith("🤖 Agents on dev"));
    expect(again!.text).toMatch(/1\. .*← current/);
    const [switched] = await exchange("/use 2", (m) => m.text.startsWith("Switched to"));
    expect(switched!.text).toContain("Last message:");
  });

  it("catches up on output it missed while the bridge was down", async () => {
    const prompt = "Keep working while the bridge restarts";
    const from = vk.sent.length;
    const firstOutput = vk.next((m) => !m.text.startsWith("✔"), TURN_TIMEOUT);
    vk.receive(USER, prompt);
    await firstOutput;
    await app.stop();
    await new Promise((r) => setTimeout(r, 4000));
    const done = vk.next((m) => m.text.includes("✅ Done"), TURN_TIMEOUT);
    await start();
    await done;

    // Everything the agent said in that turn reached the chat once, in order.
    const agentId = app.store.chat(USER).agents.dev;
    const page = await app.nodes
      .get("dev")!
      .api.agents.ref(agentId!)
      .timeline.refetch({ direction: "tail", limit: 500, projection: "projected" });
    const items = page.entries.map((entry) => entry.item as AgentTimelineItem);
    const turnStart = items.findLastIndex(
      (item) => item.type === "user_message" && item.text === prompt,
    );
    expect(turnStart).toBeGreaterThanOrEqual(0);
    const said = items
      .slice(turnStart + 1)
      .flatMap((item) => (item.type === "assistant_message" ? [markdownToPlain(item.text)] : []))
      .join("");
    const posted = vk.sent
      .slice(from)
      .flatMap((m) => m.text.split("\n\n"))
      .filter((paragraph) => !isChrome(paragraph))
      .join("");
    expect(squash(posted)).toBe(squash(said));
  });

  it("turns away users outside the allowlist", async () => {
    const reply = vk.next((m) => m.peerId === 999);
    vk.receive(999, "hello");
    expect((await reply).text).toContain("Your VK user ID is 999");
  });
});
