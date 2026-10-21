import { randomInt } from "node:crypto";

export const VK_API_VERSION = "5.199";

/** VK error codes worth retrying: unknown, too many requests, flood control, internal error. */
const RETRYABLE_CODES = new Set([1, 6, 9, 10]);

const TRUSTED_DOMAINS = [
  "vk.com",
  "vk.ru",
  "vk.me",
  "vkuser.net",
  "userapi.com",
  "vkuserphoto.ru",
  "vk-cdn.net",
  "vkuseraudio.net",
  "vkuservideo.net",
];

export function isTrustedVkHost(host: string): boolean {
  return TRUSTED_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export class VkApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    description: string,
  ) {
    super(`VK ${method} failed with error ${code}: ${description}`);
    this.name = "VkApiError";
  }

  get retryable(): boolean {
    return RETRYABLE_CODES.has(this.code);
  }
}

/** Network, HTTP or decoding failure. The request may or may not have reached VK. */
export class VkTransportError extends Error {
  readonly retryable = true;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "VkTransportError";
  }
}

export interface LongPollServer {
  server: string;
  key: string;
  ts: string;
}

export interface LongPollBatch {
  ts?: string;
  failed?: number;
  updates: unknown[];
}

export interface DownloadedFile {
  bytes: Uint8Array;
  contentType: string | null;
}

export interface VkApiOptions {
  token: string;
  groupId: number;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
  /** Spacing between API calls. Community tokens allow 20 per second. */
  minRequestIntervalMs?: number;
  requestTimeoutMs?: number;
  /** Which hosts long-poll servers and downloads may use. */
  trustHost?: (host: string) => boolean;
  /** Tests only: accept plain HTTP from trusted hosts. */
  allowHttp?: boolean;
  sleep?: (ms: number) => Promise<void>;
}

type Params = Record<string, string | number | boolean | undefined>;

export class VkApi {
  readonly groupId: number;
  private readonly token: string;
  private readonly apiBaseUrl: string;
  private readonly fetch: typeof fetch;
  private readonly interval: number;
  private readonly timeout: number;
  private readonly trustHost: (host: string) => boolean;
  private readonly allowHttp: boolean;
  private readonly sleep: (ms: number) => Promise<void>;
  private nextRequestAt = 0;

  constructor(options: VkApiOptions) {
    this.token = options.token;
    this.groupId = options.groupId;
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://api.vk.com/method").replace(/\/$/, "");
    this.fetch = options.fetch ?? globalThis.fetch;
    this.interval = options.minRequestIntervalMs ?? 60;
    this.timeout = options.requestTimeoutMs ?? 20_000;
    this.trustHost = options.trustHost ?? isTrustedVkHost;
    this.allowHttp = options.allowHttp ?? false;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async call<T>(method: string, params: Params = {}): Promise<T> {
    const now = Date.now();
    const wait = Math.max(0, this.nextRequestAt - now);
    this.nextRequestAt = Math.max(this.nextRequestAt, now) + this.interval;
    if (wait > 0) await this.sleep(wait);

    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined)
        body.set(key, typeof value === "boolean" ? (value ? "1" : "0") : String(value));
    }
    body.set("access_token", this.token);
    body.set("v", VK_API_VERSION);

    let response: Response;
    try {
      response = await this.fetch(`${this.apiBaseUrl}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(this.timeout),
      });
    } catch (error) {
      // Never include the request in the message; its body carries the token.
      throw new VkTransportError(`VK ${method} request failed`, { cause: error });
    }
    if (!response.ok) throw new VkTransportError(`VK ${method} returned HTTP ${response.status}`);
    let envelope: { response?: T; error?: { error_code?: number; error_msg?: string } };
    try {
      envelope = (await response.json()) as typeof envelope;
    } catch (error) {
      throw new VkTransportError(`VK ${method} returned invalid JSON`, { cause: error });
    }
    if (envelope.error) {
      throw new VkApiError(
        method,
        envelope.error.error_code ?? 0,
        envelope.error.error_msg ?? "unknown error",
      );
    }
    if (envelope.response === undefined) {
      throw new VkTransportError(`VK ${method} response is missing`);
    }
    return envelope.response;
  }

  /** Turns on Long Poll with `message_new` when the community has it off. */
  async ensureLongPoll(): Promise<void> {
    const settings = await this.call<{ is_enabled?: boolean; events?: Record<string, number> }>(
      "groups.getLongPollSettings",
      { group_id: this.groupId },
    );
    if (settings.is_enabled && settings.events?.message_new === 1) return;
    await this.call("groups.setLongPollSettings", {
      group_id: this.groupId,
      enabled: 1,
      api_version: VK_API_VERSION,
      message_new: 1,
    });
  }

  async longPollServer(): Promise<LongPollServer> {
    const server = await this.call<{ server: string; key: string; ts: string | number }>(
      "groups.getLongPollServer",
      { group_id: this.groupId },
    );
    this.trustedUrl(server.server);
    return { server: server.server, key: server.key, ts: String(server.ts) };
  }

  async longPollCheck(
    server: LongPollServer,
    ts: string,
    options: { waitSeconds?: number; signal?: AbortSignal } = {},
  ): Promise<LongPollBatch> {
    const wait = options.waitSeconds ?? 25;
    const url = new URL(server.server);
    url.searchParams.set("act", "a_check");
    url.searchParams.set("key", server.key);
    url.searchParams.set("ts", ts);
    url.searchParams.set("wait", String(wait));
    const timeout = AbortSignal.timeout((wait + 15) * 1000);
    let response: Response;
    try {
      response = await this.fetch(url, {
        signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      // The URL holds a short-lived poll key; keep it out of the error.
      throw new VkTransportError("VK long poll request failed", { cause: error });
    }
    if (!response.ok) throw new VkTransportError(`VK long poll returned HTTP ${response.status}`);
    const batch = (await response.json()) as {
      ts?: string | number;
      failed?: number;
      updates?: unknown[];
    };
    return {
      ...(batch.ts !== undefined ? { ts: String(batch.ts) } : {}),
      ...(batch.failed !== undefined ? { failed: batch.failed } : {}),
      updates: batch.updates ?? [],
    };
  }

  /**
   * Sends one message. Retries keep the same `random_id`, so VK delivers an uncertain
   * send at most once.
   */
  async sendMessage(input: {
    peerId: number;
    text: string;
    keyboard?: string;
    replyTo?: number;
  }): Promise<number> {
    const randomId = randomInt(1, 2 ** 31 - 1);
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.call<number>("messages.send", {
          peer_id: input.peerId,
          message: input.text,
          random_id: randomId,
          keyboard: input.keyboard,
          reply_to: input.replyTo,
          dont_parse_links: 1,
          disable_mentions: 1,
        });
      } catch (error) {
        const retryable =
          (error instanceof VkApiError || error instanceof VkTransportError) && error.retryable;
        if (!retryable || attempt >= 3) throw error;
        await this.sleep(1000 * 2 ** attempt);
      }
    }
  }

  async setTyping(peerId: number): Promise<void> {
    await this.call("messages.setActivity", {
      peer_id: peerId,
      type: "typing",
      group_id: this.groupId,
    });
  }

  /** Downloads an attachment, following redirects only to trusted VK hosts. */
  async download(rawUrl: string, limitBytes: number): Promise<DownloadedFile> {
    let url = this.trustedUrl(rawUrl);
    for (let redirects = 0; ; redirects++) {
      let response: Response;
      try {
        response = await this.fetch(url, {
          redirect: "manual",
          signal: AbortSignal.timeout(120_000),
        });
      } catch (error) {
        throw new VkTransportError("attachment download failed", { cause: error });
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location || redirects >= 4) {
          throw new VkTransportError("attachment redirect is missing or loops");
        }
        url = this.trustedUrl(new URL(location, url).toString());
        continue;
      }
      if (!response.ok)
        throw new VkTransportError(`attachment download returned HTTP ${response.status}`);
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > limitBytes) {
        await response.body?.cancel();
        throw new AttachmentTooLargeError(limitBytes);
      }
      const bytes = await readLimited(response, limitBytes);
      return { bytes, contentType: response.headers.get("content-type") };
    }
  }

  private trustedUrl(raw: string): URL {
    const url = new URL(raw);
    if (!this.trustHost(url.hostname) || url.username || url.password) {
      throw new VkTransportError(`refusing untrusted host ${url.hostname}`);
    }
    if (url.protocol !== "https:" && !(this.allowHttp && url.protocol === "http:")) {
      throw new VkTransportError(`refusing ${url.protocol} URL from ${url.hostname}`);
    }
    return url;
  }
}

export class AttachmentTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`attachment is larger than ${Math.round(limitBytes / 1024 / 1024)} MB`);
    this.name = "AttachmentTooLargeError";
  }
}

async function readLimited(response: Response, limitBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limitBytes) {
      await reader.cancel();
      throw new AttachmentTooLargeError(limitBytes);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
