import type { SessionEntry } from "../config/sessions.js";
import { normalizeProviderId } from "./model-selection.js";

export function getClaudeSdkSessionId(
  entry: SessionEntry | undefined,
  provider: string,
): string | undefined {
  const normalized = normalizeProviderId(provider);
  if (!normalized) return undefined;
  const map = entry?.sdkSessionIds ?? {};
  const value = map[normalized];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function setClaudeSdkSessionId(
  entry: SessionEntry,
  provider: string,
  sessionId: string,
): void {
  const normalized = normalizeProviderId(provider);
  if (!normalized) return;
  const trimmed = sessionId.trim();
  if (!trimmed) return;
  entry.sdkSessionIds = {
    ...entry.sdkSessionIds,
    [normalized]: trimmed,
  };
}
