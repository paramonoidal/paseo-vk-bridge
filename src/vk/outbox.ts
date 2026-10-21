import { errorMessage, type Logger } from "../log.js";
import type { VkApi } from "./api.js";
import { splitText } from "./text.js";

const TYPING_INTERVAL_MS = 5000;

export interface SendOptions {
  /** Attached to the last chunk. */
  keyboard?: string;
  replyTo?: number;
}

/**
 * Sends messages to each chat in order. Agent output arrives from several async
 * sources, and VK must show it in the order it was produced.
 */
export class VkOutbox {
  private readonly queues = new Map<number, Promise<void>>();
  private readonly lastTyping = new Map<number, number>();

  constructor(
    private readonly api: VkApi,
    private readonly chunkLimit: number,
    private readonly logger: Logger,
  ) {}

  send(peerId: number, text: string, options: SendOptions = {}): Promise<void> {
    const chunks = splitText(text, this.chunkLimit);
    if (chunks.length === 0) return Promise.resolve();
    const previous = this.queues.get(peerId) ?? Promise.resolve();
    const run = previous.then(async () => {
      for (const [index, chunk] of chunks.entries()) {
        const last = index === chunks.length - 1;
        await this.api.sendMessage({
          peerId,
          text: chunk,
          ...(last && options.keyboard ? { keyboard: options.keyboard } : {}),
          ...(index === 0 && options.replyTo ? { replyTo: options.replyTo } : {}),
        });
      }
      // VK hides the typing indicator once a message arrives; let the next one show again.
      this.lastTyping.delete(peerId);
    });
    const tail = run.catch((error) => {
      this.logger.error("VK send failed", { peerId, error: errorMessage(error) });
    });
    this.queues.set(peerId, tail);
    void tail.then(() => {
      if (this.queues.get(peerId) === tail) this.queues.delete(peerId);
    });
    return run;
  }

  /** Shows "typing…" in the chat, at most once per interval. */
  typing(peerId: number): void {
    const now = Date.now();
    if (now - (this.lastTyping.get(peerId) ?? 0) < TYPING_INTERVAL_MS) return;
    this.lastTyping.set(peerId, now);
    this.api.setTyping(peerId).catch((error) => {
      this.logger.debug("VK typing failed", { peerId, error: errorMessage(error) });
    });
  }

  /** Waits until everything queued so far has been sent or has failed. */
  async idle(): Promise<void> {
    await Promise.all(this.queues.values());
  }
}
