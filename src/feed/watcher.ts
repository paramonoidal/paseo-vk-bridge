import type {
  PaseoAgentHandle,
  PaseoAgentTimelineEvent,
  PaseoAgentTimelineSubscription,
} from "@getpaseo/client";
import type { AgentPermissionRequest, AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { errorMessage, type Logger } from "../log.js";
import type { PaseoNode } from "../paseo/nodes.js";
import type { StateStore, TimelineCursor } from "../store.js";
import type { SendOptions } from "../vk/outbox.js";
import { choiceKeyboard } from "../vk/keyboard.js";
import { type TurnOutcome, TurnFeed } from "./feed.js";
import { describePermission } from "./permissions.js";

export interface ChatSink {
  send(text: string, options?: SendOptions): Promise<void>;
  typing(): void;
}

export interface AgentWatcherOptions {
  node: PaseoNode;
  agentId: string;
  store: StateStore;
  sink: ChatSink;
  logger: Logger;
  showActions: boolean;
  flushAfterMs: number;
  /** User message IDs this bridge sends start with this prefix. */
  ownMessagePrefix: string;
}

const TICK_MS = 2000;
const CATCH_UP_PAGES = 10;
const RESUBSCRIBE_MS = 5000;

/**
 * Follows one agent's timeline and posts it to one chat. The last seen timeline row
 * is persisted, so after a reconnect or a bridge restart the chat catches up on
 * what it missed instead of repeating or dropping output.
 */
export class AgentWatcher {
  readonly key: string;
  private readonly handle: PaseoAgentHandle;
  private readonly feed: TurnFeed;
  private readonly pending = new Map<string, AgentPermissionRequest>();
  private subscription: PaseoAgentTimelineSubscription | null = null;
  private timer: NodeJS.Timeout | null = null;
  private resubscribeTimer: NodeJS.Timeout | null = null;
  /** Events are applied one at a time, in arrival order. */
  private queue: Promise<void> = Promise.resolve();
  private catchingUp = false;
  private buffered: PaseoAgentTimelineEvent[] = [];
  private tickQueued = false;
  private stopped = false;

  constructor(private readonly options: AgentWatcherOptions) {
    this.key = `${options.node.name}/${options.agentId}`;
    this.handle = options.node.api.agents.ref(options.agentId);
    this.feed = new TurnFeed({
      emit: (text) => void options.sink.send(text),
      showActions: options.showActions,
      flushAfterMs: options.flushAfterMs,
      isOwnMessage: (id) => id.startsWith(options.ownMessagePrefix),
    });
  }

  get node(): PaseoNode {
    return this.options.node;
  }

  get agentId(): string {
    return this.options.agentId;
  }

  /** Permission requests waiting on the user, oldest first. */
  pendingPermissions(): AgentPermissionRequest[] {
    return [...this.pending.values()];
  }

  resolved(requestId: string): void {
    this.pending.delete(requestId);
  }

  async start(): Promise<void> {
    await this.subscribe();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref();
  }

  /** Posts anything pending and stops following the agent. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.resubscribeTimer) clearTimeout(this.resubscribeTimer);
    await this.queue;
    this.feed.flush();
    const subscription = this.subscription;
    this.subscription = null;
    await subscription?.release().catch(() => {});
  }

  private async subscribe(): Promise<void> {
    this.catchingUp = true;
    const subscription = this.handle.timeline.subscribe((event) => this.onEvent(event));
    this.subscription = subscription;
    try {
      await subscription.ready;
    } catch (error) {
      this.catchingUp = false;
      this.scheduleResubscribe(error);
      return;
    }
    this.enqueue(() => this.catchUp());
  }

  private scheduleResubscribe(error: unknown): void {
    if (this.stopped || this.resubscribeTimer) return;
    this.options.logger.warn("timeline subscription failed; retrying", {
      error: errorMessage(error),
    });
    this.subscription = null;
    this.resubscribeTimer = setTimeout(() => {
      this.resubscribeTimer = null;
      if (!this.stopped) void this.subscribe();
    }, RESUBSCRIBE_MS);
    this.resubscribeTimer.unref();
  }

  private onEvent(event: PaseoAgentTimelineEvent): void {
    if (this.stopped) return;
    if (this.catchingUp) {
      this.buffered.push(event);
      return;
    }
    this.enqueue(() => this.apply(event));
  }

  private enqueue(task: () => Promise<void> | void): void {
    this.queue = this.queue.then(task).catch((error) => {
      this.options.logger.error("timeline event failed", { error: errorMessage(error) });
    });
  }

  private tick(): void {
    if (this.tickQueued) return;
    this.tickQueued = true;
    this.enqueue(() => {
      this.tickQueued = false;
      if (this.feed.active) this.options.sink.typing();
      this.feed.tick();
    });
  }

  private get cursor(): TimelineCursor | undefined {
    return this.options.store.cursor(this.key);
  }

  private set cursor(cursor: TimelineCursor | undefined) {
    this.options.store.setCursor(this.key, cursor);
  }

  /** Accepts a row unless it is at or before the cursor of the same epoch. */
  private acceptRow(epoch: string | undefined, seq: number | undefined): boolean {
    if (epoch === undefined || seq === undefined) return true;
    const cursor = this.cursor;
    if (cursor && cursor.epoch === epoch && seq <= cursor.seq) return false;
    this.cursor = { epoch, seq };
    return true;
  }

  private row(item: AgentTimelineItem, turnId: string | undefined): void {
    this.feed.row({ item, turnId });
  }

  private async apply(event: PaseoAgentTimelineEvent): Promise<void> {
    const payload = event.event;
    const { seq, epoch, timestamp } = event as { seq?: number; epoch?: string; timestamp?: string };
    switch (payload.type) {
      case "timeline":
        if (this.acceptRow(epoch, seq)) this.row(payload.item as AgentTimelineItem, payload.turnId);
        return;
      case "turn_started":
        this.feed.startTurn(Date.parse(timestamp ?? "") || undefined);
        this.options.sink.typing();
        return;
      case "turn_completed":
        this.endTurn({ kind: "completed" });
        return;
      case "turn_failed":
        this.endTurn({ kind: "failed", error: payload.error });
        return;
      case "turn_canceled":
        this.endTurn({ kind: "canceled" });
        return;
      case "permission_requested":
        await this.announce(payload.request as AgentPermissionRequest);
        return;
      case "permission_resolved":
        this.pending.delete(payload.requestId);
        return;
      case "replacement":
        // The timeline was rewritten; positions from the old epoch no longer apply.
        this.cursor = undefined;
        return;
      case "subscription_restored":
        this.catchingUp = true;
        await this.catchUp();
        return;
      case "error":
        this.scheduleResubscribe(new Error(payload.error));
        return;
      default:
        return;
    }
  }

  private endTurn(outcome: TurnOutcome): void {
    this.feed.endTurn(outcome);
  }

  private async announce(request: AgentPermissionRequest): Promise<void> {
    if (this.pending.has(request.id)) return;
    this.pending.set(request.id, request);
    this.feed.flush();
    const prompt = describePermission(request);
    await this.options.sink.send(prompt.text, {
      ...(prompt.buttons.length > 0
        ? { keyboard: choiceKeyboard(prompt.buttons.map((label) => ({ label }))) }
        : {}),
    });
  }

  /**
   * Replays rows after the saved cursor, then reconciles turn and permission state
   * with the agent's snapshot. Live events that arrived meanwhile are applied after.
   */
  private async catchUp(): Promise<void> {
    try {
      let after = this.cursor;
      for (let page = 0; after && page < CATCH_UP_PAGES; page++) {
        const result = await this.handle.timeline.refetch({
          direction: "after",
          cursor: after,
          limit: 200,
          projection: "canonical",
        });
        if (result.epoch !== after.epoch || result.reset || result.staleCursor) break;
        for (const entry of result.entries) {
          if (this.acceptRow(result.epoch, entry.seqEnd)) {
            this.row(entry.item as AgentTimelineItem, entry.turnId);
          }
        }
        if (!result.hasNewer || !result.endCursor) break;
        after = result.endCursor;
      }
      const snapshot = (await this.handle.refresh())?.agent;
      if (snapshot) {
        const activeTurn = snapshot.activeTurn;
        if (activeTurn && !this.feed.active) {
          this.feed.startTurn(Date.parse(activeTurn.startedAt ?? "") || undefined);
        } else if (!activeTurn && this.feed.active && snapshot.status !== "running") {
          this.feed.endTurn(
            snapshot.status === "error"
              ? { kind: "failed", error: snapshot.lastError ?? "the agent reported an error" }
              : { kind: "completed" },
          );
        }
        const live = new Set(snapshot.pendingPermissions.map((request) => request.id));
        for (const id of this.pending.keys()) if (!live.has(id)) this.pending.delete(id);
        for (const request of snapshot.pendingPermissions) {
          await this.announce(request as AgentPermissionRequest);
        }
      }
    } catch (error) {
      this.options.logger.warn("timeline catch-up failed", { error: errorMessage(error) });
    } finally {
      this.catchingUp = false;
      const buffered = this.buffered.splice(0);
      for (const event of buffered) await this.apply(event);
    }
  }
}
