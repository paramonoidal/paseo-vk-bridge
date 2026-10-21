import { errorMessage, type Logger } from "../log.js";
import type { StateStore } from "../store.js";
import type { LongPollServer, VkApi } from "./api.js";
import { eventId } from "./message.js";

export interface VkPollerOptions {
  api: VkApi;
  store: StateStore;
  logger: Logger;
  /** Handles one event. Errors are logged; the event is not retried. */
  handle(event: unknown): Promise<void>;
  /** Called for an event that was being handled when the bridge stopped. */
  interrupted(event: unknown): Promise<void>;
  waitSeconds?: number;
}

/**
 * Bots Long Poll loop. Each batch is journaled together with its cursor before any
 * event is handled, so a restart neither loses nor repeats a message. An event caught
 * mid-dispatch by a restart is reported instead of being run twice.
 */
export class VkPoller {
  private readonly abort = new AbortController();
  private loop: Promise<void> | null = null;

  constructor(private readonly options: VkPollerOptions) {}

  start(): void {
    this.loop ??= this.run();
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await this.loop;
  }

  private async run(): Promise<void> {
    const { api, store, logger } = this.options;
    const signal = this.abort.signal;
    let server: LongPollServer | null = null;
    let backoff = 1000;
    while (!signal.aborted) {
      try {
        await this.drain();
        if (signal.aborted) break;
        if (!server) {
          server = await api.longPollServer();
          if (store.pollTs === null) await store.stagePoll(server.ts, []);
        }
        const ts = store.pollTs ?? server.ts;
        const batch = await api.longPollCheck(server, ts, {
          signal,
          ...(this.options.waitSeconds !== undefined
            ? { waitSeconds: this.options.waitSeconds }
            : {}),
        });
        switch (batch.failed) {
          case undefined: {
            const events = batch.updates.flatMap((event) => {
              const id = eventId(event);
              return id ? [{ id, event }] : [];
            });
            await store.stagePoll(batch.ts ?? ts, events);
            break;
          }
          case 1:
            // History is outdated: continue from the cursor VK supplies.
            if (batch.ts) await store.stagePoll(batch.ts, []);
            break;
          case 2:
            // The key expired; the stored cursor stays valid.
            server = null;
            break;
          case 3:
            server = await api.longPollServer();
            await store.stagePoll(server.ts, []);
            break;
          default:
            throw new Error(`VK long poll failed with code ${batch.failed}`);
        }
        backoff = 1000;
      } catch (error) {
        if (signal.aborted) break;
        logger.warn("VK polling failed; retrying", {
          error: errorMessage(error),
          backoffMs: backoff,
        });
        server = null;
        await delay(backoff, signal);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  private async drain(): Promise<void> {
    const { store, logger } = this.options;
    for (;;) {
      const entry = store.nextInbox();
      if (!entry) return;
      try {
        if (entry.state === "dispatching") {
          await this.options.interrupted(entry.event);
        } else {
          await store.markInbox(entry.id, "dispatching");
          await this.options.handle(entry.event);
        }
      } catch (error) {
        logger.error("VK event handling failed", { eventId: entry.id, error: errorMessage(error) });
      }
      await store.markInbox(entry.id, "done");
    }
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
