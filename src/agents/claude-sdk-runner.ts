import os from "node:os";

import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { resolveHeartbeatPrompt } from "../auto-reply/heartbeat.js";
import type { ThinkLevel, VerboseLevel } from "../auto-reply/thinking.js";
import type { ClawdbotConfig } from "../config/config.js";
import { resolveSessionAgentIds } from "./agent-scope.js";
import { createClaudeSdkMcpServer } from "./claude-sdk-tools.js";
import { coerceToFailoverError } from "./failover-error.js";
import type { EmbeddedPiRunResult } from "./pi-embedded.js";
import {
  buildBootstrapContextFiles,
  type EmbeddedContextFile,
} from "./pi-embedded-helpers.js";
import { createClawdbotCodingTools } from "./pi-tools.js";
import type { SkillSnapshot } from "./skills.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";
import { normalizeUsage } from "./usage.js";
import {
  filterBootstrapFilesForSession,
  loadWorkspaceBootstrapFiles,
} from "./workspace.js";

type ImageContent = {
  type: "image";
  data: string;
  mimeType: string;
};

type SdkMessageParam = {
  role: "user" | "assistant" | "system";
  content: unknown;
};

type SdkAssistantMessage = {
  content?: unknown;
};

function resolveUserTimezone(configured?: string): string {
  const trimmed = configured?.trim();
  if (trimmed) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).format(
        new Date(),
      );
      return trimmed;
    } catch {
      // ignore invalid timezone
    }
  }
  const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return host?.trim() || "UTC";
}

function formatUserTime(date: Date, timeZone: string): string | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      weekday: "long",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const map: Record<string, string> = {};
    for (const part of parts) {
      if (part.type !== "literal") map[part.type] = part.value;
    }
    if (
      !map.weekday ||
      !map.year ||
      !map.month ||
      !map.day ||
      !map.hour ||
      !map.minute
    ) {
      return undefined;
    }
    return `${map.weekday} ${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}`;
  } catch {
    return undefined;
  }
}

function buildModelAliasLines(cfg?: ClawdbotConfig) {
  const models = cfg?.agents?.defaults?.models ?? {};
  const entries: Array<{ alias: string; model: string }> = [];
  for (const [keyRaw, entryRaw] of Object.entries(models)) {
    const model = String(keyRaw ?? "").trim();
    if (!model) continue;
    const alias = String(
      (entryRaw as { alias?: string } | undefined)?.alias ?? "",
    ).trim();
    if (!alias) continue;
    entries.push({ alias, model });
  }
  return entries
    .sort((a, b) => a.alias.localeCompare(b.alias))
    .map((entry) => `- ${entry.alias}: ${entry.model}`);
}

function buildSystemPrompt(params: {
  workspaceDir: string;
  config?: ClawdbotConfig;
  defaultThinkLevel?: ThinkLevel;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  heartbeatPrompt?: string;
  tools: { name: string }[];
  toolSummaries?: Record<string, string>;
  contextFiles?: EmbeddedContextFile[];
  modelDisplay: string;
}) {
  const userTimezone = resolveUserTimezone(
    params.config?.agents?.defaults?.userTimezone,
  );
  const userTime = formatUserTime(new Date(), userTimezone);
  return buildAgentSystemPrompt({
    workspaceDir: params.workspaceDir,
    defaultThinkLevel: params.defaultThinkLevel,
    extraSystemPrompt: params.extraSystemPrompt,
    ownerNumbers: params.ownerNumbers,
    reasoningTagHint: false,
    heartbeatPrompt: params.heartbeatPrompt,
    runtimeInfo: {
      host: "clawdbot",
      os: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      node: process.version,
      model: params.modelDisplay,
    },
    toolNames: params.tools.map((tool) => tool.name),
    toolSummaries: params.toolSummaries,
    modelAliasLines: buildModelAliasLines(params.config),
    userTimezone,
    userTime,
    contextFiles: params.contextFiles,
  });
}

function normalizeClaudeSdkModel(modelId: string): string {
  const trimmed = modelId.trim();
  if (!trimmed) return trimmed;
  const lower = trimmed.toLowerCase();
  if (
    lower === "opus" ||
    lower === "opus-4.5" ||
    lower === "opus-4" ||
    lower === "claude-opus-4-5" ||
    lower === "claude-opus-4"
  ) {
    return "claude-opus-4-5";
  }
  if (
    lower === "sonnet" ||
    lower === "sonnet-4.5" ||
    lower === "sonnet-4.1" ||
    lower === "sonnet-4.0" ||
    lower === "claude-sonnet-4-5" ||
    lower === "claude-sonnet-4-1" ||
    lower === "claude-sonnet-4-0"
  ) {
    return "claude-sonnet-4-5";
  }
  if (
    lower === "haiku" ||
    lower === "haiku-3.5" ||
    lower === "claude-haiku-3-5"
  ) {
    return "claude-haiku-3-5";
  }
  return trimmed;
}

function extractAssistantText(message: SdkAssistantMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const record = block as { type?: unknown; text?: unknown };
      return record.type === "text" && typeof record.text === "string"
        ? record.text
        : "";
    })
    .join("");
}

function extractStreamDeltaText(event: unknown): string {
  if (!event || typeof event !== "object") return "";
  const record = event as Record<string, unknown>;
  const delta = record.delta;
  if (delta && typeof delta === "object") {
    const deltaRecord = delta as Record<string, unknown>;
    if (typeof deltaRecord.text === "string") return deltaRecord.text;
    if (
      deltaRecord.type === "text_delta" &&
      typeof deltaRecord.text === "string"
    ) {
      return deltaRecord.text;
    }
  }
  if (typeof record.text === "string") return record.text;
  return "";
}

type MessagingTracker = {
  sentTexts: string[];
  sentTargets: {
    tool: string;
    provider: string;
    accountId?: string;
    to?: string;
  }[];
};

export async function runClaudeSdkAgent(params: {
  sessionId: string;
  sdkSessionId?: string;
  sessionKey?: string;
  messageProvider?: string;
  agentAccountId?: string;
  currentChannelId?: string;
  currentThreadTs?: string;
  replyToMode?: "off" | "first" | "all";
  hasRepliedRef?: { value: boolean };
  sessionFile: string;
  workspaceDir: string;
  agentDir: string;
  config?: ClawdbotConfig;
  skillsSnapshot?: SkillSnapshot;
  prompt: string;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  provider?: string;
  model?: string;
  authProfileId?: string;
  thinkLevel?: ThinkLevel;
  verboseLevel?: VerboseLevel;
  timeoutMs: number;
  runId: string;
  images?: ImageContent[];
  onPartialReply?: (payload: {
    text?: string;
    mediaUrls?: string[];
  }) => void | Promise<void>;
}): Promise<EmbeddedPiRunResult> {
  const started = Date.now();
  const abortController = new AbortController();
  const timeout = setTimeout(
    () => {
      abortController.abort(new Error("claude-sdk timeout"));
    },
    Math.max(1, params.timeoutMs),
  );

  let aborted = false;
  abortController.signal.addEventListener(
    "abort",
    () => {
      aborted = true;
    },
    { once: true },
  );

  try {
    const provider = params.provider ?? "claude-sdk";
    const modelId = normalizeClaudeSdkModel(params.model ?? "claude-opus-4-5");
    const modelDisplay = `${provider}/${modelId}`;
    const tools = createClawdbotCodingTools({
      messageProvider: params.messageProvider,
      agentAccountId: params.agentAccountId,
      sessionKey: params.sessionKey,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      config: params.config,
      abortSignal: abortController.signal,
      modelProvider: provider,
      currentChannelId: params.currentChannelId,
      currentThreadTs: params.currentThreadTs,
      replyToMode: params.replyToMode,
      hasRepliedRef: params.hasRepliedRef,
    });

    const messagingTracker: MessagingTracker = {
      sentTexts: [],
      sentTargets: [],
    };
    const { server, allowedTools } = createClaudeSdkMcpServer({
      tools,
      tracker: {
        sentTexts: messagingTracker.sentTexts,
        sentTargets: messagingTracker.sentTargets,
      },
      abortSignal: abortController.signal,
    });
    const toolSummaries: Record<string, string> = {};
    for (const toolDef of tools) {
      const name = `mcp__clawdbot-tools__${toolDef.name}`;
      const description =
        typeof toolDef.description === "string" && toolDef.description.trim()
          ? toolDef.description.trim()
          : toolDef.label || toolDef.name;
      toolSummaries[name] = description;
    }

    const bootstrapFiles = filterBootstrapFilesForSession(
      await loadWorkspaceBootstrapFiles(params.workspaceDir),
      params.sessionKey ?? params.sessionId,
    );
    const contextFiles = buildBootstrapContextFiles(bootstrapFiles);
    const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
      sessionKey: params.sessionKey,
      config: params.config,
    });
    const heartbeatPrompt =
      sessionAgentId === defaultAgentId
        ? resolveHeartbeatPrompt(
            params.config?.agents?.defaults?.heartbeat?.prompt,
          )
        : undefined;
    const systemPrompt = buildSystemPrompt({
      workspaceDir: params.workspaceDir,
      config: params.config,
      defaultThinkLevel: params.thinkLevel,
      extraSystemPrompt: params.extraSystemPrompt,
      ownerNumbers: params.ownerNumbers,
      heartbeatPrompt,
      tools: allowedTools.map((name) => ({ name })),
      toolSummaries,
      contextFiles,
      modelDisplay,
    });

    const content: Array<Record<string, unknown>> = [];
    const promptText = params.prompt.trim();
    if (promptText) {
      content.push({ type: "text", text: promptText });
    }
    const images = params.images ?? [];
    for (const image of images) {
      const data = image.data?.trim();
      if (!data) continue;
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: image.mimeType,
          data,
        },
      });
    }

    const buildPrompt = async function* (): AsyncGenerator<SDKUserMessage> {
      const message: SdkMessageParam = {
        role: "user",
        content: content.length > 0 ? content : params.prompt,
      };
      yield {
        type: "user",
        message,
        parent_tool_use_id: null,
        session_id: params.sdkSessionId ?? params.sessionId,
      } as SDKUserMessage;
    };

    const queryOptions = {
      abortController,
      cwd: params.workspaceDir,
      model: modelId,
      tools: [],
      mcpServers: { "clawdbot-tools": server },
      allowedTools,
      canUseTool: async () => ({ behavior: "allow" as const }),
      systemPrompt,
      resume: params.sdkSessionId,
      includePartialMessages: Boolean(params.onPartialReply),
    };

    let sessionId: string | undefined;
    let assistantText = "";
    let resultText: string | undefined;
    let usage: ReturnType<typeof normalizeUsage>;
    let resultError: string | undefined;

    const stream = query({
      prompt: buildPrompt(),
      options: queryOptions,
    });

    for await (const message of stream) {
      sessionId = sessionId ?? (message as { session_id?: string }).session_id;
      if (message.type === "assistant") {
        const assistantMessage = message.message;
        assistantText = extractAssistantText(assistantMessage);
      } else if (message.type === "stream_event" && params.onPartialReply) {
        const delta = extractStreamDeltaText(
          (message as { event?: unknown }).event,
        );
        if (delta) {
          assistantText += delta;
          await params.onPartialReply({ text: assistantText });
        }
      } else if (message.type === "result") {
        if (message.subtype === "success") {
          resultText = message.result?.trim() || undefined;
          usage = normalizeUsage(message.usage);
        } else {
          resultError = message.subtype;
          usage = normalizeUsage(message.usage);
        }
      }
    }

    if (resultError) {
      throw new Error(`claude-sdk failed (${resultError})`);
    }

    const text = resultText ?? assistantText.trim();
    const payloads = text ? [{ text }] : [];

    return {
      payloads,
      meta: {
        durationMs: Date.now() - started,
        aborted,
        agentMeta: {
          sessionId: sessionId ?? params.sdkSessionId ?? params.sessionId,
          provider,
          model: modelId,
          usage: usage ?? undefined,
        },
      },
      didSendViaMessagingTool: messagingTracker.sentTexts.length > 0,
      messagingToolSentTexts: messagingTracker.sentTexts.slice(),
      messagingToolSentTargets: messagingTracker.sentTargets.slice(),
    };
  } catch (err) {
    const failover = coerceToFailoverError(err, {
      provider: params.provider ?? "claude-sdk",
      model: params.model,
      profileId: params.authProfileId,
    });
    if (failover) throw failover;
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
