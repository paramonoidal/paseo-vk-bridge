import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type InboxState = "pending" | "dispatching" | "done";

export interface InboxEntry {
  id: string;
  state: InboxState;
  /** Raw VK event. Dropped once handled; the ID alone deduplicates redeliveries. */
  event: unknown;
  createdAt: number;
}

export interface ChatState {
  /** Node this chat currently talks to. */
  node: string | null;
  /** Agent bound to this chat, per node. */
  agents: Record<string, string>;
}

export interface TimelineCursor {
  epoch: string;
  seq: number;
}

interface StateData {
  version: 1;
  pollTs: string | null;
  inbox: InboxEntry[];
  chats: Record<string, ChatState>;
  cursors: Record<string, TimelineCursor>;
}

const DEDUPE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const CURSOR_SAVE_DELAY_MS = 1000;

function emptyState(): StateData {
  return { version: 1, pollTs: null, inbox: [], chats: {}, cursors: {} };
}

/**
 * Bridge state in one JSON file. Every write replaces the file atomically, and writes
 * are serialized, so a crash leaves either the previous or the next complete state.
 */
export class StateStore {
  private dirty = false;
  private writing: Promise<void> | null = null;
  private cursorTimer: NodeJS.Timeout | null = null;

  private constructor(
    private readonly file: string,
    private readonly data: StateData,
    private readonly now: () => number,
  ) {}

  static async open(file: string, now: () => number = Date.now): Promise<StateStore> {
    let data = emptyState();
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<StateData>;
      if (parsed.version !== 1) throw new Error(`unsupported state version ${parsed.version}`);
      data = { ...emptyState(), ...parsed } as StateData;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`cannot load state from ${file}: ${(error as Error).message}`);
      }
    }
    await mkdir(path.dirname(file), { recursive: true });
    return new StateStore(file, data, now);
  }

  get pollTs(): string | null {
    return this.data.pollTs;
  }

  /** Stores a poll batch and its cursor together, so no event is lost or replayed on restart. */
  async stagePoll(ts: string, events: ReadonlyArray<{ id: string; event: unknown }>) {
    const cutoff = this.now() - DEDUPE_WINDOW_MS;
    this.data.inbox = this.data.inbox.filter(
      (entry) => entry.state !== "done" || entry.createdAt >= cutoff,
    );
    const known = new Set(this.data.inbox.map((entry) => entry.id));
    for (const { id, event } of events) {
      if (known.has(id)) continue;
      known.add(id);
      this.data.inbox.push({ id, state: "pending", event, createdAt: this.now() });
    }
    this.data.pollTs = ts;
    await this.save();
  }

  nextInbox(): InboxEntry | undefined {
    return this.data.inbox.find((entry) => entry.state !== "done");
  }

  async markInbox(id: string, state: InboxState) {
    const entry = this.data.inbox.find((candidate) => candidate.id === id);
    if (!entry) return;
    entry.state = state;
    if (state === "done") entry.event = null;
    await this.save();
  }

  chat(peerId: number): ChatState {
    return this.data.chats[String(peerId)] ?? { node: null, agents: {} };
  }

  async updateChat(peerId: number, update: (chat: ChatState) => ChatState) {
    this.data.chats[String(peerId)] = update(structuredClone(this.chat(peerId)));
    await this.save();
  }

  chats(): Array<{ peerId: number; chat: ChatState }> {
    return Object.entries(this.data.chats).map(([peerId, chat]) => ({
      peerId: Number(peerId),
      chat,
    }));
  }

  cursor(key: string): TimelineCursor | undefined {
    return this.data.cursors[key];
  }

  /** Cursors move with every timeline row, so they are written in batches. */
  setCursor(key: string, cursor: TimelineCursor | undefined) {
    if (cursor) this.data.cursors[key] = cursor;
    else delete this.data.cursors[key];
    if (this.cursorTimer) return;
    this.cursorTimer = setTimeout(() => {
      this.cursorTimer = null;
      void this.save();
    }, CURSOR_SAVE_DELAY_MS);
    this.cursorTimer.unref();
  }

  async flush() {
    if (this.cursorTimer) {
      clearTimeout(this.cursorTimer);
      this.cursorTimer = null;
      this.dirty = true;
    }
    if (this.dirty || this.writing) await this.save();
  }

  save(): Promise<void> {
    this.dirty = true;
    this.writing ??= this.drain();
    return this.writing;
  }

  private async drain() {
    try {
      while (this.dirty) {
        this.dirty = false;
        const temporary = `${this.file}.tmp-${process.pid}`;
        await writeFile(temporary, JSON.stringify(this.data), { mode: 0o600 });
        await rename(temporary, this.file);
      }
    } finally {
      this.writing = null;
    }
  }
}
