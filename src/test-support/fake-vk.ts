import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface SentMessage {
  peerId: number;
  text: string;
  keyboard: { inline?: boolean; buttons: Array<Array<{ action: { label: string } }>> } | null;
}

interface Waiter {
  predicate: (message: SentMessage) => boolean;
  resolve: (message: SentMessage) => void;
}

/**
 * Just enough of the VK API for the bridge: Bots Long Poll, messages.send,
 * messages.setActivity, and attachment downloads.
 */
export class FakeVk {
  readonly sent: SentMessage[] = [];
  typing = 0;
  private readonly updates: unknown[] = [];
  private readonly files = new Map<string, { type: string; body: Buffer }>();
  private readonly polls: Array<() => void> = [];
  private readonly waiters: Waiter[] = [];
  private server: Server | null = null;
  private nextMessageId = 1000;
  private nextEventId = 1;

  constructor(readonly groupId: number) {}

  get baseUrl(): string {
    const port = (this.server?.address() as AddressInfo).port;
    return `http://127.0.0.1:${port}`;
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => void this.route(request, response));
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
  }

  async stop(): Promise<void> {
    for (const release of this.polls.splice(0)) release();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    this.server?.closeAllConnections();
  }

  hostFile(name: string, type: string, body: Buffer): string {
    this.files.set(name, { type, body });
    return `${this.baseUrl}/files/${name}`;
  }

  /** Delivers an incoming message, as VK would through Long Poll. */
  receive(fromId: number, text: string, extra: Record<string, unknown> = {}): number {
    const id = this.nextMessageId++;
    this.updates.push({
      type: "message_new",
      event_id: `event-${this.nextEventId++}`,
      v: "5.199",
      group_id: this.groupId,
      object: {
        message: {
          id,
          date: 0,
          peer_id: fromId,
          from_id: fromId,
          text,
          out: 0,
          attachments: [],
          ...extra,
        },
        client_info: {},
      },
    });
    for (const release of this.polls.splice(0)) release();
    return id;
  }

  /** Resolves with the first message sent from now on that matches. */
  next(predicate: (message: SentMessage) => boolean, timeoutMs = 20_000): Promise<SentMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(`no matching VK message within ${timeoutMs}ms; sent:\n${this.transcript()}`),
        );
      }, timeoutMs);
      this.waiters.push({
        predicate,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
    });
  }

  transcript(): string {
    return this.sent.map((message) => `→ ${message.text}`).join("\n---\n");
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", this.baseUrl);
    if (url.pathname === "/lp") return this.longPoll(url, response);
    if (url.pathname.startsWith("/files/")) {
      const file = this.files.get(url.pathname.slice("/files/".length));
      if (!file) return void response.writeHead(404).end();
      return void response.writeHead(200, { "content-type": file.type }).end(file.body);
    }
    const method = url.pathname.replace(/^\/method\//, "");
    const params = new URLSearchParams(await readBody(request));
    const reply = (value: unknown) =>
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ response: value }));
    switch (method) {
      case "groups.getLongPollSettings":
        return void reply({ is_enabled: true, events: { message_new: 1 } });
      case "groups.getLongPollServer":
        return void reply({ server: `${this.baseUrl}/lp`, key: "key", ts: "0" });
      case "messages.setActivity":
        this.typing++;
        return void reply(1);
      case "messages.send": {
        const keyboard = params.get("keyboard");
        const message: SentMessage = {
          peerId: Number(params.get("peer_id")),
          text: params.get("message") ?? "",
          keyboard: keyboard ? JSON.parse(keyboard) : null,
        };
        this.sent.push(message);
        for (const waiter of [...this.waiters]) {
          if (waiter.predicate(message)) {
            this.waiters.splice(this.waiters.indexOf(waiter), 1);
            waiter.resolve(message);
          }
        }
        return void reply(this.sent.length);
      }
      default:
        return void response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ error: { error_code: 3, error_msg: `Unknown method ${method}` } }));
    }
  }

  private longPoll(url: URL, response: ServerResponse): void {
    const ts = Number(url.searchParams.get("ts") ?? "0");
    const wait = Number(url.searchParams.get("wait") ?? "1");
    const answer = () => {
      const updates = this.updates.slice(ts);
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ ts: String(ts + updates.length), updates }));
    };
    if (this.updates.length > ts) return answer();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      answer();
    };
    const timer = setTimeout(finish, wait * 1000);
    this.polls.push(finish);
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}
