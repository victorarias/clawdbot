import crypto from "node:crypto";

import {
  createSdkMcpServer,
  type McpServerConfig,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
  getChannelPlugin,
  normalizeChannelId,
} from "../channels/plugins/index.js";
import { buildZodShapeFromJsonSchema } from "./claude-sdk-schema.js";
import {
  isMessagingTool,
  isMessagingToolSendAction,
  type MessagingToolSend,
  normalizeTargetForProvider,
} from "./pi-embedded-messaging.js";

type CallToolResult = {
  content: unknown;
  structuredContent?: Record<string, unknown>;
};

type MessagingTracker = {
  sentTexts: string[];
  sentTargets: MessagingToolSend[];
};

function extractMessagingToolSend(
  toolName: string,
  args: Record<string, unknown>,
): MessagingToolSend | undefined {
  const action = typeof args.action === "string" ? args.action.trim() : "";
  const accountIdRaw =
    typeof args.accountId === "string" ? args.accountId.trim() : undefined;
  const accountId = accountIdRaw ? accountIdRaw : undefined;
  if (toolName === "message") {
    if (action !== "send" && action !== "thread-reply") return undefined;
    const toRaw = typeof args.to === "string" ? args.to : undefined;
    if (!toRaw) return undefined;
    const providerRaw =
      typeof args.provider === "string" ? args.provider.trim() : "";
    const providerId = providerRaw ? normalizeChannelId(providerRaw) : null;
    const provider =
      providerId ?? (providerRaw ? providerRaw.toLowerCase() : "message");
    const to = normalizeTargetForProvider(provider, toRaw);
    return to ? { tool: toolName, provider, accountId, to } : undefined;
  }
  const providerId = normalizeChannelId(toolName);
  if (!providerId) return undefined;
  const plugin = getChannelPlugin(providerId);
  const extracted = plugin?.actions?.extractToolSend?.({ args });
  if (!extracted?.to) return undefined;
  const to = normalizeTargetForProvider(providerId, extracted.to);
  return to
    ? {
        tool: toolName,
        provider: providerId,
        accountId: extracted.accountId ?? accountId,
        to,
      }
    : undefined;
}

function extractMessagingText(
  args: Record<string, unknown>,
): string | undefined {
  const content =
    typeof args.content === "string"
      ? args.content
      : typeof args.message === "string"
        ? args.message
        : undefined;
  const trimmed = content?.trim();
  return trimmed ? trimmed : undefined;
}

export function createClaudeSdkMcpServer(params: {
  tools: AgentTool[];
  tracker: MessagingTracker;
  abortSignal?: AbortSignal;
}): { server: McpServerConfig; allowedTools: string[] } {
  const { tools, tracker, abortSignal } = params;
  const serverName = "clawdbot-tools";
  const allowedTools: string[] = [];

  const sdkTools = tools.map((toolDef) => {
    const toolName = toolDef.name;
    const description =
      typeof toolDef.description === "string" && toolDef.description.trim()
        ? toolDef.description.trim()
        : toolDef.label || toolName;
    const shape = buildZodShapeFromJsonSchema(toolDef.parameters);
    const toolFn = tool(
      toolName,
      description,
      shape,
      async (args): Promise<CallToolResult> => {
        const params = args as Record<string, unknown>;
        if (abortSignal?.aborted) {
          throw abortSignal.reason ?? new Error("aborted");
        }
        const toolCallId = crypto.randomUUID();
        const result = await toolDef.execute(toolCallId, params, abortSignal);
        if (
          isMessagingTool(toolName) &&
          isMessagingToolSendAction(toolName, params)
        ) {
          const sendTarget = extractMessagingToolSend(toolName, params);
          if (sendTarget) tracker.sentTargets.push(sendTarget);
          const text = extractMessagingText(params);
          if (text) tracker.sentTexts.push(text);
        }
        const details =
          result.details &&
          typeof result.details === "object" &&
          !Array.isArray(result.details)
            ? (result.details as Record<string, unknown>)
            : undefined;
        return {
          content: result.content,
          structuredContent: details,
        };
      },
    );
    allowedTools.push(`mcp__${serverName}__${toolName}`);
    return toolFn;
  });

  return {
    server: createSdkMcpServer({
      name: serverName,
      version: "1.0.0",
      tools: sdkTools,
    }),
    allowedTools,
  };
}
