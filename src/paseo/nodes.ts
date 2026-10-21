import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { createPaseoApi, type PaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { parseConnectionOfferFromUrl } from "@getpaseo/protocol/connection-offer";
import {
  buildDaemonWebSocketUrl,
  buildRelayWebSocketUrl,
  parseRelayConnectionUri,
  shouldUseTlsForDefaultHostedRelay,
} from "@getpaseo/protocol/daemon-endpoints";
import WebSocket from "ws";
import type { NodeConfig } from "../config.js";
import { errorMessage, type Logger } from "../log.js";

/** The SDK version, reported to the daemon like the CLI reports its own. */
const CLIENT_VERSION: string = JSON.parse(
  readFileSync(
    path.join(
      path.dirname(createRequire(import.meta.url).resolve("@getpaseo/client")),
      "../package.json",
    ),
    "utf8",
  ),
).version;

export type NodeStatus = "connecting" | "connected" | "offline";

export interface NodeEndpoint {
  url: string;
  password?: string;
  e2ee?: { enabled: true; daemonPublicKeyB64: string };
  /** Where the bridge reaches the node, for display. */
  via: string;
}

/** Turns a node's `pairing` or `url` setting into a WebSocket endpoint. */
export function resolveEndpoint(config: NodeConfig): NodeEndpoint {
  if (config.pairing !== undefined) {
    const pairing = config.pairing.trim();
    const parsed = pairing.startsWith("relay://")
      ? parseRelayConnectionUri(pairing)
      : (() => {
          const offer = parseConnectionOfferFromUrl(pairing);
          if (!offer) throw new Error("pairing must be a Paseo pairing link or a relay:// URI");
          return { offer };
        })();
    const { offer } = parsed;
    const password: string | undefined =
      config.password ??
      ("password" in parsed ? (parsed.password as string | undefined) : undefined);
    return {
      url: buildRelayWebSocketUrl({
        endpoint: offer.relay.endpoint,
        serverId: offer.serverId,
        role: "client",
        useTls: offer.relay.useTls ?? shouldUseTlsForDefaultHostedRelay(offer.relay.endpoint),
      }),
      e2ee: { enabled: true, daemonPublicKeyB64: offer.daemonPublicKeyB64 },
      ...(password ? { password } : {}),
      via: `relay ${offer.relay.endpoint}`,
    };
  }
  const raw = (config.url ?? "").trim();
  const url = /^wss?:\/\//.test(raw) ? raw : buildDaemonWebSocketUrl(raw, { useTls: false });
  return {
    url,
    ...(config.password ? { password: config.password } : {}),
    via: new URL(url).host,
  };
}

export interface PaseoNode {
  readonly name: string;
  readonly config: NodeConfig;
  readonly client: DaemonClient;
  readonly api: PaseoApi;
  readonly via: string;
  status(): NodeStatus;
  hostname(): string | null;
  lastError(): string | null;
}

class Node implements PaseoNode {
  readonly client: DaemonClient;
  readonly api: PaseoApi;
  readonly via: string;

  constructor(
    readonly name: string,
    readonly config: NodeConfig,
    logger: Logger,
  ) {
    const endpoint = resolveEndpoint(config);
    this.via = endpoint.via;
    const credentialFile = config.localCredentialFile;
    this.client = new DaemonClient({
      url: endpoint.url,
      clientId: `vk-bridge-${name}`,
      clientType: "cli",
      appVersion: CLIENT_VERSION,
      ...(endpoint.password ? { password: endpoint.password } : {}),
      ...(endpoint.e2ee ? { e2ee: endpoint.e2ee } : {}),
      ...(credentialFile
        ? {
            localCredential: async () =>
              (await readFile(credentialFile, "utf8").catch(() => "")).trim() || undefined,
          }
        : {}),
      webSocketFactory: (url, options) =>
        new WebSocket(url, options?.protocols, { headers: options?.headers }) as never,
      reconnect: { enabled: true, baseDelayMs: 1000, maxDelayMs: 30_000 },
      logger: daemonClientLogger(logger),
    });
    this.api = createPaseoApi(this.client);
  }

  status(): NodeStatus {
    const state = this.client.getConnectionState().status;
    if (state === "connected") return "connected";
    if (state === "connecting" || state === "idle") return "connecting";
    return "offline";
  }

  hostname(): string | null {
    return this.client.getLastServerInfoMessage()?.hostname ?? null;
  }

  lastError(): string | null {
    return this.client.lastError ?? null;
  }
}

/** One owner-level connection per configured node. Each reconnects on its own. */
export class NodeRegistry {
  private readonly nodes = new Map<string, Node>();
  private readonly listeners = new Set<(node: PaseoNode, status: NodeStatus) => void>();
  private readonly unsubscribers: Array<() => void> = [];

  constructor(
    configs: Record<string, NodeConfig>,
    private readonly logger: Logger,
  ) {
    for (const [name, config] of Object.entries(configs)) {
      this.nodes.set(name, new Node(name, config, logger.child({ node: name })));
    }
  }

  start(): void {
    for (const node of this.nodes.values()) {
      let previous: NodeStatus | null = null;
      this.unsubscribers.push(
        node.client.subscribeConnectionStatus(() => {
          const status = node.status();
          if (status === previous) return;
          previous = status;
          this.logger.info("node connection changed", { node: node.name, status, via: node.via });
          for (const listener of this.listeners) listener(node, status);
        }),
      );
      // With reconnect on, connect() settles only once connected or on an auth failure.
      node.client.connect().catch((error) => {
        this.logger.error("node connection stopped", {
          node: node.name,
          error: errorMessage(error),
        });
      });
    }
  }

  get(name: string): PaseoNode | undefined {
    return this.nodes.get(name);
  }

  list(): PaseoNode[] {
    return [...this.nodes.values()];
  }

  names(): string[] {
    return [...this.nodes.keys()];
  }

  onStatusChange(listener: (node: PaseoNode, status: NodeStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    await Promise.all(
      this.list().map(async (node) => {
        await node.api.dispose().catch(() => {});
        await node.client.close().catch(() => {});
      }),
    );
  }
}

function daemonClientLogger(logger: Logger) {
  const fields = (obj: object) => obj as Record<string, unknown>;
  return {
    debug: (obj: object, msg?: string) => logger.debug(msg ?? "daemon client", fields(obj)),
    info: (obj: object, msg?: string) => logger.debug(msg ?? "daemon client", fields(obj)),
    warn: (obj: object, msg?: string) => logger.warn(msg ?? "daemon client", fields(obj)),
    error: (obj: object, msg?: string) => logger.error(msg ?? "daemon client", fields(obj)),
  };
}
