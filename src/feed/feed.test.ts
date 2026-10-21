import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { describe, expect, it } from "vitest";
import { formatDuration, TurnFeed } from "./feed.js";

function setup(options: { showActions?: boolean; flushAfterMs?: number } = {}) {
  let now = 1_000_000;
  const out: string[] = [];
  const feed = new TurnFeed({
    emit: (text) => out.push(text),
    showActions: options.showActions ?? true,
    flushAfterMs: options.flushAfterMs ?? 45_000,
    isOwnMessage: (id) => id.startsWith("vk:"),
    now: () => now,
  });
  return {
    feed,
    out,
    advance: (ms: number) => {
      now += ms;
    },
    at: () => now,
  };
}

const text = (value: string, messageId?: string): AgentTimelineItem => ({
  type: "assistant_message",
  text: value,
  ...(messageId ? { messageId } : {}),
});

const shell = (callId: string, command: string, status = "completed"): AgentTimelineItem =>
  ({
    type: "tool_call",
    callId,
    name: "shell",
    status,
    error: null,
    detail: { type: "shell", command },
  }) as AgentTimelineItem;

describe("TurnFeed", () => {
  it("posts each agent message after the titles of the actions before it", () => {
    const { feed, out, advance, at } = setup();
    feed.startTurn(at());
    feed.row({ item: { type: "user_message", text: "check CAN", clientMessageId: "vk:1:5" } });
    feed.row({ item: text("I'll compare the ") });
    feed.row({ item: text("channels.") });
    feed.row({ item: shell("a", "bash -lc 'python probe.py'") });
    feed.row({ item: shell("b", "python probe.py --can 2") });
    feed.row({
      item: {
        type: "tool_call",
        callId: "c",
        name: "apply_patch",
        status: "completed",
        error: null,
        detail: { type: "edit", filePath: "/w/probe.py", unifiedDiff: "+a\n+b\n-c" },
      } as AgentTimelineItem,
    });
    feed.row({ item: text("**CAN 1** reports a fault.") });
    advance(7 * 60_000 + 8_000);
    feed.endTurn({ kind: "completed" });

    expect(out).toEqual([
      "I'll compare the channels.",
      "💻 Ran 2 commands\n✏️ Edited probe.py\n\nCAN 1 reports a fault.\n\n✅ Done in 7m 8s · 1 file changed +2 −1",
    ]);
  });

  it("updates an action in place when its call completes", () => {
    const { feed, out } = setup();
    feed.row({ item: shell("a", "make", "running") });
    feed.row({
      item: { ...(shell("a", "make", "failed") as object), error: "x" } as AgentTimelineItem,
    });
    feed.endTurn({ kind: "failed", error: "make failed" });
    expect(out).toEqual([
      expect.stringMatching(/^💻 Ran make — failed\n\n❌ Failed after 0s: make failed$/),
    ]);
  });

  it("separates messages with different IDs", () => {
    const { feed, out } = setup();
    feed.row({ item: text("one", "m1") });
    feed.row({ item: text("two", "m2") });
    feed.endTurn({ kind: "completed" });
    expect(out).toEqual(["one", "two\n\n✅ Done in 0s"]);
  });

  it("shows messages typed in Paseo but not its own", () => {
    const { feed, out } = setup();
    feed.row({ item: { type: "user_message", text: "mine", clientMessageId: "vk:1:2" } });
    feed.row({ item: { type: "user_message", text: "from the app", clientMessageId: "app-1" } });
    expect(out).toEqual(["👤 from the app"]);
  });

  it("posts waiting action titles during a long run of tool calls", () => {
    const { feed, out, advance } = setup({ flushAfterMs: 45_000 });
    feed.startTurn();
    feed.row({ item: shell("a", "make") });
    advance(30_000);
    feed.tick();
    expect(out).toEqual([]);
    feed.row({ item: shell("b", "make test") });
    advance(20_000);
    feed.tick();
    expect(out).toEqual(["💻 Ran 2 commands"]);
  });

  it("posts a message the agent stopped extending", () => {
    const { feed, out, advance } = setup({ flushAfterMs: 10_000 });
    feed.row({ item: text("thinking out loud") });
    advance(9_000);
    feed.tick();
    expect(out).toEqual([]);
    advance(2_000);
    feed.tick();
    expect(out).toEqual(["thinking out loud"]);
  });

  it("hides action titles when they are turned off", () => {
    const { feed, out } = setup({ showActions: false });
    feed.row({ item: shell("a", "ls") });
    feed.row({ item: text("Listed.") });
    feed.endTurn({ kind: "canceled" });
    expect(out).toEqual(["Listed.\n\n⏹ Stopped after 0s"]);
  });

  it("does not repeat the summary for a turn already closed", () => {
    const { feed, out } = setup();
    feed.row({ item: text("done") });
    feed.endTurn({ kind: "completed" });
    feed.endTurn({ kind: "completed" });
    expect(out).toEqual(["done\n\n✅ Done in 0s"]);
  });

  it("reports errors right away", () => {
    const { feed, out } = setup();
    feed.row({ item: text("trying") });
    feed.row({ item: { type: "error", message: "rate limited" } });
    expect(out).toEqual(["trying", "⚠️ rate limited"]);
  });
});

describe("formatDuration", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatDuration(12_400)).toBe("12s");
    expect(formatDuration(428_000)).toBe("7m 8s");
    expect(formatDuration(3_900_000)).toBe("1h 5m");
  });
});
