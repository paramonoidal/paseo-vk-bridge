import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { StateStore } from "./store.js";

async function tempFile() {
  return path.join(await mkdtemp(path.join(tmpdir(), "vk-bridge-store-")), "state.json");
}

describe("StateStore", () => {
  it("journals events with the cursor and survives reopening", async () => {
    const file = await tempFile();
    const store = await StateStore.open(file);
    await store.stagePoll("12", [
      { id: "a", event: { n: 1 } },
      { id: "a", event: { n: 1 } },
      { id: "b", event: { n: 2 } },
    ]);
    expect(store.nextInbox()).toMatchObject({ id: "a", state: "pending" });
    await store.markInbox("a", "dispatching");

    const reopened = await StateStore.open(file);
    expect(reopened.pollTs).toBe("12");
    expect(reopened.nextInbox()).toMatchObject({ id: "a", state: "dispatching" });
    await reopened.markInbox("a", "done");
    await reopened.markInbox("b", "done");
    await reopened.stagePoll("13", [{ id: "a", event: { n: 1 } }]);
    expect(reopened.nextInbox()).toBeUndefined();
  });

  it("forgets handled events after a week", async () => {
    let now = 0;
    const store = await StateStore.open(await tempFile(), () => now);
    await store.stagePoll("1", [{ id: "old", event: {} }]);
    await store.markInbox("old", "done");
    now = 8 * 24 * 60 * 60 * 1000;
    await store.stagePoll("2", [{ id: "old", event: {} }]);
    expect(store.nextInbox()).toMatchObject({ id: "old", state: "pending" });
  });

  it("keeps chat bindings and batches cursor writes", async () => {
    const file = await tempFile();
    const store = await StateStore.open(file);
    await store.updateChat(42, (chat) => ({
      ...chat,
      node: "laptop",
      agents: { laptop: "agent-1" },
    }));
    store.setCursor("laptop/agent-1", { epoch: "e", seq: 3 });
    await store.flush();
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved.chats["42"]).toEqual({ node: "laptop", agents: { laptop: "agent-1" } });
    expect(saved.cursors["laptop/agent-1"]).toEqual({ epoch: "e", seq: 3 });
    expect((await StateStore.open(file)).chat(42).agents.laptop).toBe("agent-1");
  });
});
