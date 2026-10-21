import { Bridge } from "./bridge.js";
import type { BridgeConfig } from "./config.js";
import { errorMessage, type Logger } from "./log.js";
import { NodeRegistry } from "./paseo/nodes.js";
import { StateStore } from "./store.js";
import { createTranscriber } from "./transcribe/index.js";
import { VkApi, type VkApiOptions } from "./vk/api.js";
import { VkOutbox } from "./vk/outbox.js";
import { VkPoller } from "./vk/poller.js";

export interface AppOverrides {
  /** Test hooks: point the VK client at a fake server. */
  vk?: Partial<VkApiOptions>;
  pollWaitSeconds?: number;
}

export interface RunningApp {
  bridge: Bridge;
  nodes: NodeRegistry;
  store: StateStore;
  stop(): Promise<void>;
}

export async function startApp(
  config: BridgeConfig,
  logger: Logger,
  overrides: AppOverrides = {},
): Promise<RunningApp> {
  const store = await StateStore.open(config.stateFile);
  const vk = new VkApi({ token: config.vk.token, groupId: config.vk.groupId, ...overrides.vk });
  try {
    await vk.ensureLongPoll();
  } catch (error) {
    // A token without the `manage` scope cannot change settings; polling may still work.
    logger.warn("could not verify Long Poll settings", { error: errorMessage(error) });
  }
  const outbox = new VkOutbox(vk, config.vk.textChunkLimit, logger.child({ component: "vk" }));
  const nodes = new NodeRegistry(config.nodes, logger.child({ component: "paseo" }));
  const bridge = new Bridge({
    config,
    vk,
    outbox,
    store,
    nodes,
    transcriber: createTranscriber(config.transcription),
    logger: logger.child({ component: "bridge" }),
  });
  const poller = new VkPoller({
    api: vk,
    store,
    logger: logger.child({ component: "poller" }),
    handle: (event) => bridge.handleEvent(event),
    interrupted: (event) => bridge.handleInterrupted(event),
    ...(overrides.pollWaitSeconds !== undefined ? { waitSeconds: overrides.pollWaitSeconds } : {}),
  });

  nodes.start();
  bridge.start();
  poller.start();
  logger.info("bridge started", { nodes: nodes.names(), groupId: config.vk.groupId });

  let stopping: Promise<void> | null = null;
  return {
    bridge,
    nodes,
    store,
    stop: () => {
      stopping ??= (async () => {
        await poller.stop();
        await bridge.stop();
        await outbox.idle();
        await nodes.close();
        await store.flush();
        logger.info("bridge stopped");
      })();
      return stopping;
    },
  };
}

/** Verifies the VK token and each node's connection, for `--check`. */
export async function checkSetup(config: BridgeConfig, logger: Logger): Promise<boolean> {
  let ok = true;
  const vk = new VkApi({ token: config.vk.token, groupId: config.vk.groupId });
  try {
    await vk.longPollServer();
    console.log(`✔ VK community ${config.vk.groupId}: Long Poll available`);
  } catch (error) {
    ok = false;
    console.log(`✘ VK community ${config.vk.groupId}: ${errorMessage(error)}`);
  }
  const nodes = new NodeRegistry(config.nodes, logger);
  nodes.start();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && nodes.list().some((node) => node.status() !== "connected")) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  for (const node of nodes.list()) {
    if (node.status() === "connected") {
      const snapshot = await node.api.providers
        .waitForReady({ timeoutMs: 15_000 })
        .catch(() => node.api.providers.snapshot())
        .catch(() => null);
      const providers = snapshot?.entries
        .filter((entry) => entry.status === "ready")
        .map((entry) => entry.provider)
        .join(", ");
      console.log(
        `✔ node ${node.name} (${node.hostname() ?? "?"}, ${node.via}): providers ${providers || "none ready"}`,
      );
    } else {
      ok = false;
      console.log(`✘ node ${node.name} (${node.via}): ${node.lastError() ?? node.status()}`);
    }
  }
  await nodes.close();
  return ok;
}
