import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TemplateContext } from "../templating.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { createMockTypingController } from "./test-helpers.js";

const runClaudeSdkAgentMock = vi.fn();
const runWithModelFallbackMock = vi.fn();

vi.mock("../../agents/model-fallback.js", () => ({
  runWithModelFallback: (params: {
    provider: string;
    model: string;
    run: (provider: string, model: string) => Promise<unknown>;
  }) => runWithModelFallbackMock(params),
}));

vi.mock("../../agents/claude-sdk-runner.js", () => ({
  runClaudeSdkAgent: (params: unknown) => runClaudeSdkAgentMock(params),
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: () => {
    throw new Error("runEmbeddedPiAgent should not be called for claude-sdk");
  },
}));

vi.mock("./queue.js", async () => {
  const actual =
    await vi.importActual<typeof import("./queue.js")>("./queue.js");
  return {
    ...actual,
    enqueueFollowupRun: vi.fn(),
    scheduleFollowupDrain: vi.fn(),
  };
});

import { runReplyAgent } from "./agent-runner.js";

type ClaudeSdkAgentParams = {
  enforceFinalTag?: boolean;
  bashElevated?: {
    enabled: boolean;
    allowed: boolean;
    defaultLevel: "off" | "on";
  };
};

function createRun() {
  const typing = createMockTypingController();
  const sessionCtx = {
    Provider: "telegram",
    OriginatingTo: "chat:1",
    AccountId: "primary",
    MessageSid: "msg",
  } as unknown as TemplateContext;
  const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
  const followupRun = {
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    run: {
      agentId: "main",
      agentDir: "/tmp/agent",
      sessionId: "session",
      sessionKey: "main",
      messageProvider: "telegram",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: {},
      skillsSnapshot: {},
      provider: "claude-sdk",
      model: "claude-opus-4-5",
      thinkLevel: "low",
      verboseLevel: "off",
      elevatedLevel: "off",
      bashElevated: {
        enabled: true,
        allowed: true,
        defaultLevel: "on",
      },
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
      enforceFinalTag: true,
    },
  } as unknown as FollowupRun;

  return runReplyAgent({
    commandBody: "hello",
    followupRun,
    queueKey: "main",
    resolvedQueue,
    shouldSteer: false,
    shouldFollowup: false,
    isActive: false,
    isStreaming: false,
    typing,
    sessionCtx,
    sessionKey: "main",
    defaultModel: "anthropic/claude-opus-4-5",
    resolvedVerboseLevel: "off",
    isNewSession: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    shouldInjectGroupIntro: false,
    typingMode: "instant",
  });
}

describe("runReplyAgent claude-sdk plumbing", () => {
  beforeEach(() => {
    runClaudeSdkAgentMock.mockReset();
    runWithModelFallbackMock.mockReset();
  });

  it("passes enforceFinalTag and bashElevated to claude-sdk runner", async () => {
    runClaudeSdkAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: {},
    });
    runWithModelFallbackMock.mockImplementationOnce(
      async ({
        run,
      }: {
        run: (provider: string, model: string) => Promise<unknown>;
      }) => ({
        result: await run("claude-sdk", "claude-opus-4-5"),
        provider: "claude-sdk",
        model: "claude-opus-4-5",
      }),
    );

    await createRun();

    const call = runClaudeSdkAgentMock.mock.calls[0]?.[0] as
      | ClaudeSdkAgentParams
      | undefined;
    expect(call?.enforceFinalTag).toBe(true);
    expect(call?.bashElevated).toEqual({
      enabled: true,
      allowed: true,
      defaultLevel: "on",
    });
  });
});
