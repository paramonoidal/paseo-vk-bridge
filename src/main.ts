#!/usr/bin/env node
import { parseArgs } from "node:util";
import { checkSetup, startApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { createLogger, errorMessage } from "./log.js";

const USAGE = `Usage: paseo-vk-bridge [--config <file>] [--check]

  -c, --config <file>  Configuration file (default: $PASEO_VK_BRIDGE_CONFIG or ./config.json)
      --check          Verify the VK token and node connections, then exit
  -h, --help           Show this help`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      config: { type: "string", short: "c" },
      check: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const file = values.config ?? process.env.PASEO_VK_BRIDGE_CONFIG ?? "config.json";
  const config = await loadConfig(file);
  if (values.check) {
    return (await checkSetup(config, createLogger({ level: "warn" }))) ? 0 : 1;
  }

  const logger = createLogger({ level: config.logLevel });

  const app = await startApp(config, logger);
  await new Promise<void>((resolve) => {
    const shutdown = (signal: string) => {
      logger.info("shutting down", { signal });
      resolve();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
  await app.stop();
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof ConfigError ? error.message : `fatal: ${errorMessage(error)}`);
    process.exit(1);
  },
);
