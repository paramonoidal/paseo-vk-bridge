export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(options: {
  level?: LogLevel;
  write?: (line: string) => void;
  fields?: Record<string, unknown>;
}): Logger {
  const threshold = LEVELS[options.level ?? "info"];
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const base = options.fields ?? {};

  function log(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVELS[level] < threshold) return;
    write(
      JSON.stringify({
        time: new Date().toISOString(),
        level,
        msg: message,
        ...base,
        ...(fields ? serializeFields(fields) : {}),
      }),
    );
  }

  return {
    debug: (message, fields) => log("debug", message, fields),
    info: (message, fields) => log("info", message, fields),
    warn: (message, fields) => log("warn", message, fields),
    error: (message, fields) => log("error", message, fields),
    child: (fields) => createLogger({ ...options, fields: { ...base, ...fields } }),
  };
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

function serializeFields(fields: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    result[key] = value instanceof Error ? { name: value.name, message: value.message } : value;
  }
  return result;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
