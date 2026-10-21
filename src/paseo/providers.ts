import type { PaseoApi } from "@getpaseo/client";

/** Modes that let an agent act without asking: Claude, Codex and common ACP spellings. */
const FULL_ACCESS_MODE_IDS = ["bypassPermissions", "full-access", "danger-full-access", "yolo"];
const FULL_ACCESS_PATTERN = /bypass|full[\s_-]?access|yolo|danger/i;

export interface ResolvedAgentConfig {
  /** `provider/model`, as the SDK expects. */
  provider: string;
  providerId: string;
  model: string;
  modeId: string | undefined;
  label: string;
}

export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}

type SnapshotEntry = Awaited<ReturnType<PaseoApi["providers"]["snapshot"]>>["entries"][number];

export function pickFullAccessMode(
  modes: ReadonlyArray<{ id: string; label?: string }> | undefined,
): string | undefined {
  if (!modes || modes.length === 0) return undefined;
  for (const id of FULL_ACCESS_MODE_IDS) {
    if (modes.some((mode) => mode.id === id)) return id;
  }
  return modes.find((mode) => FULL_ACCESS_PATTERN.test(`${mode.id} ${mode.label ?? ""}`))?.id;
}

/**
 * Resolves `provider` or `provider/model` against the node's provider catalog:
 * the provider's default model when none is given, and its full-access mode unless
 * the configuration names another.
 */
export async function resolveAgentConfig(
  api: PaseoApi,
  input: { provider: string; cwd: string; modes: Record<string, string> },
): Promise<ResolvedAgentConfig> {
  const separator = input.provider.indexOf("/");
  const providerId = separator === -1 ? input.provider : input.provider.slice(0, separator);
  const requestedModel = separator === -1 ? null : input.provider.slice(separator + 1) || null;

  let snapshot = await api.providers.snapshot({ cwd: input.cwd });
  let entry = snapshot.entries.find((candidate) => candidate.provider === providerId);
  if (entry?.status === "loading") {
    snapshot = await api.providers.waitForReady({ cwd: input.cwd, timeoutMs: 30_000 });
    entry = snapshot.entries.find((candidate) => candidate.provider === providerId);
  }
  if (!entry || entry.enabled === false) {
    const available = readyProviders(snapshot.entries).join(", ") || "none";
    throw new ProviderUnavailableError(
      `Provider "${providerId}" is not available on this node. Available: ${available}.`,
    );
  }
  if (entry.status !== "ready") {
    throw new ProviderUnavailableError(
      `Provider "${providerId}" is ${entry.status}${entry.error ? `: ${entry.error}` : ""}.`,
    );
  }

  const models = entry.models ?? [];
  const model =
    requestedModel ??
    models.find((candidate) => candidate.isDefault)?.id ??
    models.find((candidate) => candidate.isSelectable !== false)?.id;
  if (!model) {
    throw new ProviderUnavailableError(`Provider "${providerId}" reports no models.`);
  }

  return {
    provider: `${providerId}/${model}`,
    providerId,
    model,
    modeId: input.modes[providerId] ?? pickFullAccessMode(entry.modes),
    label: entry.label ?? providerId,
  };
}

export function readyProviders(entries: readonly SnapshotEntry[]): string[] {
  return entries
    .filter((entry) => entry.status === "ready" && entry.enabled !== false)
    .map((entry) => entry.provider);
}
