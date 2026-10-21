import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const NODE_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

const NodeSchema = z
  .object({
    /** Pairing link printed by `paseo daemon pair`, or a `relay://` connection URI. */
    pairing: z.string().min(1).optional(),
    /** Direct daemon endpoint: `host:port`, `ws://host:port/ws` or `wss://…`. */
    url: z.string().min(1).optional(),
    password: z.string().min(1).optional(),
    /** Path to the daemon's `$PASEO_HOME/local-credential`, for a daemon on this machine. */
    localCredentialFile: z.string().min(1).optional(),
    /** Working directory for agents started without one. Absolute path on that node. */
    cwd: z.string().min(1).optional(),
    /** Provider for new agents on this node: `codex`, `claude`, or `provider/model`. */
    provider: z.string().min(1).optional(),
  })
  .strict()
  .refine((node) => (node.pairing === undefined) !== (node.url === undefined), {
    message: "set exactly one of `pairing` or `url`",
  });

const TranscriptionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("openai"),
      /** Any OpenAI-compatible server: OpenAI, Groq, speaches, LocalAI, … */
      baseUrl: z.string().url().default("https://api.openai.com/v1"),
      apiKey: z.string().min(1).optional(),
      model: z.string().min(1).default("whisper-1"),
      language: z.string().min(2).optional(),
      prompt: z.string().optional(),
      timeoutSeconds: z.number().int().positive().default(120),
    })
    .strict(),
  z
    .object({
      kind: z.literal("command"),
      /** argv; `{file}` is replaced with the path of the downloaded audio. Stdout is the text. */
      command: z.array(z.string().min(1)).min(1),
      timeoutSeconds: z.number().int().positive().default(120),
    })
    .strict(),
  z.object({ kind: z.literal("none") }).strict(),
]);

export const ConfigSchema = z
  .object({
    vk: z
      .object({
        /** Community token with the `messages` and `manage` scopes. */
        token: z.string().min(1),
        groupId: z.number().int().positive(),
        /** Numeric VK user IDs allowed to talk to the bridge. */
        allowlist: z.array(z.number().int().positive()).min(1),
        textChunkLimit: z.number().int().min(64).max(4000).default(4000),
        attachmentLimitMb: z.number().positive().max(200).default(25),
      })
      .strict(),
    nodes: z
      .record(z.string(), NodeSchema)
      .refine((nodes) => Object.keys(nodes).length > 0, { message: "configure at least one node" })
      .refine((nodes) => Object.keys(nodes).every((name) => NODE_NAME.test(name)), {
        message: "node names use letters, digits, `-` and `_`",
      }),
    defaults: z
      .object({
        node: z.string().optional(),
        provider: z.string().min(1).default("codex"),
        /** Mode per provider. Unset providers use their full-access mode when they have one. */
        modes: z.record(z.string(), z.string()).default({}),
        /** What a message does while the agent is busy. */
        busy: z.enum(["steer", "interrupt"]).default("steer"),
      })
      .strict()
      .prefault({}),
    feed: z
      .object({
        /** Show action titles ("Ran 3 commands") between the agent's messages. */
        actions: z.boolean().default(true),
        /** Post pending action titles when the agent has been silent this long. */
        flushAfterSeconds: z.number().int().min(5).default(45),
      })
      .strict()
      .prefault({}),
    transcription: TranscriptionSchema.default({ kind: "none" }),
    stateFile: z.string().min(1).default("paseo-vk-bridge.state.json"),
    logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.defaults.node !== undefined && !(config.defaults.node in config.nodes)) {
      context.addIssue({
        code: "custom",
        path: ["defaults", "node"],
        message: `unknown node "${config.defaults.node}"`,
      });
    }
  });

export type BridgeConfig = z.infer<typeof ConfigSchema>;
export type NodeConfig = z.infer<typeof NodeSchema>;
export type TranscriptionConfig = z.infer<typeof TranscriptionSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Replaces `${NAME}` in every string with the environment variable, so secrets stay out of the file. */
export function expandEnv(value: unknown, env: NodeJS.ProcessEnv, at = "$"): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_match, name: string) => {
      const resolved = env[name];
      if (resolved === undefined) {
        throw new ConfigError(`${at}: environment variable ${name} is not set`);
      }
      return resolved;
    });
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => expandEnv(item, env, `${at}[${index}]`));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, expandEnv(item, env, `${at}.${key}`)]),
    );
  }
  return value;
}

export function parseConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const result = ConfigSchema.safeParse(expandEnv(raw, env));
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new ConfigError(`invalid configuration:\n${issues}`);
  }
  return result.data;
}

export async function loadConfig(file: string, env: NodeJS.ProcessEnv = process.env) {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    throw new ConfigError(`cannot read ${file}: ${(error as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  const config = parseConfig(raw, env);
  // A relative state file lives next to the config, not wherever the service was started.
  return {
    ...config,
    stateFile: path.resolve(path.dirname(path.resolve(file)), config.stateFile),
  };
}
