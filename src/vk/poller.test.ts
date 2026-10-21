import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { silentLogger } from "../log.js";
import { StateStore } from "../store.js";
import type { LongPollBatch, VkApi } from "./api.js";
import { VkPoller } from "./poller.js";

function message(id: number) {
  return { type: "message_new", event_id: `e${id}`, group_id: 1, object: { message: { id } } };
}

async function openStore() {
  return StateStore.open(path.join(await mkdtemp(path.join(tmpdir(), "vk-poller-")), "s.json"));
}

/** A VkApi stand-in that replays batches, then blocks until the poller stops. */
function fakeApi(batches: LongPollBatch[]) {
  const seenTs: string[] = [];
  let servers = 0;
  const api = {
    async longPollServer() {
      servers++;
      return { server: "https://lp.vk.com/x", key: `k${servers}`, ts: `${servers * 100}` };
    },
    async longPollCheck(_server: unknown, ts: string, options: { signal?: AbortSignal }) {
      seenTs.push(ts);
      const next = batches.shift();
      if (next) return next;
      return new Promise<LongPollBatch>((_resolve, reject) => {
        if (options.signal?.aborted) reject(new Error("aborted"));
        options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    },
  } as unknown as VkApi;
  return { api, seenTs, servers: () => servers };
}

async function until(condition: () => boolean) {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(condition()).toBe(true);
}

describe("VkPoller", () => {
  it("journals each batch, then handles its events in order", async () => {
    const store = await openStore();
    const { api, seenTs } = fakeApi([
      { ts: "101", updates: [message(1), message(2)] },
      { ts: "102", updates: [message(2), message(3)] },
    ]);
    const handled: unknown[] = [];
    const poller = new VkPoller({
      api,
      store,
      logger: silentLogger,
      handle: async (event) => {
        handled.push((event as { event_id: string }).event_id);
      },
      interrupted: async () => {},
    });
    poller.start();
    await until(() => handled.length === 3);
    await poller.stop();
    expect(handled).toEqual(["e1", "e2", "e3"]);
    expect(seenTs.slice(0, 2)).toEqual(["100", "101"]);
    expect(store.pollTs).toBe("102");
  });

  it("reports an event interrupted mid-dispatch instead of running it again", async () => {
    const store = await openStore();
    await store.stagePoll("5", [{ id: "e9", event: message(9) }]);
    await store.markInbox("e9", "dispatching");
    const { api } = fakeApi([]);
    const handled: unknown[] = [];
    const interrupted: unknown[] = [];
    const poller = new VkPoller({
      api,
      store,
      logger: silentLogger,
      handle: async (event) => {
        handled.push(event);
      },
      interrupted: async (event) => {
        interrupted.push(event);
      },
    });
    poller.start();
    await until(() => interrupted.length === 1);
    await poller.stop();
    expect(handled).toEqual([]);
    expect(store.nextInbox()).toBeUndefined();
  });

  it("keeps the cursor when the key expires and takes VK's on lost history", async () => {
    const store = await openStore();
    const { api, seenTs, servers } = fakeApi([
      { failed: 2, updates: [] },
      { failed: 1, ts: "150", updates: [] },
      { failed: 3, updates: [] },
    ]);
    const poller = new VkPoller({
      api,
      store,
      logger: silentLogger,
      handle: async () => {},
      interrupted: async () => {},
    });
    poller.start();
    await until(() => seenTs.length === 4);
    await poller.stop();
    expect(seenTs).toEqual(["100", "100", "150", "300"]);
    expect(servers()).toBe(3);
  });
});
