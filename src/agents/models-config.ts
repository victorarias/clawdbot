import fs from "node:fs/promises";
import path from "node:path";

import { type ClawdbotConfig, loadConfig } from "../config/config.js";
import type { ModelsConfig as ModelsConfigShape } from "../config/types.js";
import {
  DEFAULT_COPILOT_API_BASE_URL,
  resolveCopilotApiToken,
} from "../providers/github-copilot-token.js";
import { resolveClawdbotAgentDir } from "./agent-paths.js";
import {
  normalizeProviders,
  type ProviderConfig,
  resolveImplicitCopilotProvider,
  resolveImplicitProviders,
} from "./models-config.providers.js";

type ModelsConfig = NonNullable<ClawdbotConfig["models"]>;
type ProviderConfig = NonNullable<ModelsConfig["providers"]>[string];

const DEFAULT_MODE: NonNullable<ModelsConfig["mode"]> = "merge";

const MINIMAX_API_BASE_URL = "https://api.minimax.io/anthropic";
const MINIMAX_DEFAULT_MODEL_ID = "MiniMax-M2.1";
const MINIMAX_DEFAULT_CONTEXT_WINDOW = 200000;
const MINIMAX_DEFAULT_MAX_TOKENS = 8192;
// Pricing: MiniMax doesn't publish public rates. Override in models.json for accurate costs.
const MINIMAX_API_COST = {
  input: 15,
  output: 60,
  cacheRead: 2,
  cacheWrite: 10,
};

const MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1";
const MOONSHOT_DEFAULT_MODEL_ID = "kimi-k2-0905-preview";
const MOONSHOT_DEFAULT_CONTEXT_WINDOW = 256000;
const MOONSHOT_DEFAULT_MAX_TOKENS = 8192;
const MOONSHOT_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function mergeProviderModels(
  implicit: ProviderConfig,
  explicit: ProviderConfig,
): ProviderConfig {
  const implicitModels = Array.isArray(implicit.models) ? implicit.models : [];
  const explicitModels = Array.isArray(explicit.models) ? explicit.models : [];
  if (implicitModels.length === 0) return { ...implicit, ...explicit };

  const getId = (model: unknown): string => {
    if (!model || typeof model !== "object") return "";
    const id = (model as { id?: unknown }).id;
    return typeof id === "string" ? id.trim() : "";
  };
  const seen = new Set(explicitModels.map(getId).filter(Boolean));

  const mergedModels = [
    ...explicitModels,
    ...implicitModels.filter((model) => {
      const id = getId(model);
      if (!id) return false;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    }),
  ];

  return {
    ...implicit,
    ...explicit,
    models: mergedModels,
  };
}

function mergeProviders(params: {
  implicit?: Record<string, ProviderConfig> | null;
  explicit?: Record<string, ProviderConfig> | null;
}): Record<string, ProviderConfig> {
  const out: Record<string, ProviderConfig> = params.implicit
    ? { ...params.implicit }
    : {};
  for (const [key, explicit] of Object.entries(params.explicit ?? {})) {
    const providerKey = key.trim();
    if (!providerKey) continue;
    const implicit = out[providerKey];
    out[providerKey] = implicit
      ? mergeProviderModels(implicit, explicit)
      : explicit;
  }
  return out;
}
||||||| parent of b1c3e38df (refactor(models): share implicit providers)
async function readJson(pathname: string): Promise<unknown> {
  try {
    const raw = await fs.readFile(pathname, "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export async function ensureClawdbotModelsJson(
  config?: ClawdbotConfig,
  agentDirOverride?: string,
): Promise<{ agentDir: string; wrote: boolean }> {
  const cfg = config ?? loadConfig();

  const agentDir = agentDirOverride?.trim()
    ? agentDirOverride.trim()
    : resolveClawdbotAgentDir();

  const explicitProviders = cfg.models?.providers ?? {};
  const implicitProviders = resolveImplicitProviders({ agentDir });
  const providers: Record<string, ProviderConfig> = mergeProviders({
    implicit: implicitProviders,
    explicit: explicitProviders,
  });
  const implicitCopilot = await resolveImplicitCopilotProvider({ agentDir });
  if (implicitCopilot && !providers["github-copilot"]) {
    providers["github-copilot"] = implicitCopilot;
  }

  if (Object.keys(providers).length === 0) {
    return { agentDir, wrote: false };
  }

  const mode = cfg.models?.mode ?? DEFAULT_MODE;
  const targetPath = path.join(agentDir, "models.json");

  let mergedProviders = providers;
  let existingRaw = "";
  if (mode === "merge") {
    const existing = await readJson(targetPath);
    if (isRecord(existing) && isRecord(existing.providers)) {
      const existingProviders = existing.providers as Record<
        string,
        NonNullable<ModelsConfig["providers"]>[string]
      >;
      mergedProviders = mergeProviders({
        implicit: existingProviders,
        explicit: providers,
      });
    }
  }

  const normalizedProviders = normalizeProviders({
    providers: mergedProviders,
    agentDir,
  });
  const next = `${JSON.stringify({ providers: normalizedProviders }, null, 2)}\n`;
  try {
    existingRaw = await fs.readFile(targetPath, "utf8");
  } catch {
    existingRaw = "";
  }

  if (existingRaw === next) {
    return { agentDir, wrote: false };
  }

  await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(targetPath, next, { mode: 0o600 });
  return { agentDir, wrote: true };
}
