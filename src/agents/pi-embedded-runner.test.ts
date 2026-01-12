import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";

import type { ClawdbotConfig } from "../config/config.js";
import { resolveSessionAgentIds } from "./agent-scope.js";
import { ensureClawdbotModelsJson } from "./models-config.js";
import {
  applyGoogleTurnOrderingFix,
  buildEmbeddedSandboxInfo,
  createSystemPromptOverride,
  runEmbeddedPiAgent,
  splitSdkTools,
} from "./pi-embedded-runner.js";
import type { SandboxContext } from "./sandbox.js";

vi.mock("./model-auth.js", () => ({
  getApiKeyForModel: vi.fn(),
  ensureAuthProfileStore: vi.fn(() => ({ profiles: {} })),
  resolveAuthProfileOrder: vi.fn(() => []),
  resolveEnvApiKey: vi.fn(() => null),
}));

vi.mock("../providers/github-copilot-token.js", async () => {
  const actual = await vi.importActual<
    typeof import("../providers/github-copilot-token.js")
  >("../providers/github-copilot-token.js");
  return {
    ...actual,
    resolveCopilotApiToken: vi.fn(),
  };
});

vi.mock("@mariozechner/pi-ai", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-ai")>(
    "@mariozechner/pi-ai",
  );
  return {
    ...actual,
    streamSimple: (model: { api: string; provider: string; id: string }) => {
      if (model.id === "mock-error") {
        throw new Error("boom");
      }
      const stream = new actual.AssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
            stopReason: "stop",
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            timestamp: Date.now(),
          },
        });
      });
      return stream;
    },
  };
});

const makeOpenAiConfig = (modelIds: string[]) =>
  ({
    models: {
      providers: {
        openai: {
          api: "openai-responses",
          apiKey: "sk-test",
          baseUrl: "https://example.com",
          models: modelIds.map((id) => ({
            id,
            name: `Mock ${id}`,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 16_000,
            maxTokens: 2048,
          })),
        },
      },
    },
  }) satisfies ClawdbotConfig;

const ensureModels = (cfg: ClawdbotConfig, agentDir: string) =>
  ensureClawdbotModelsJson(cfg, agentDir);

const textFromContent = (content: unknown) => {
  if (typeof content === "string") return content;
  if (Array.isArray(content) && content[0]?.type === "text") {
    return (content[0] as { text?: string }).text;
  }
  return undefined;
};

const readSessionMessages = async (sessionFile: string) => {
  const raw = await fs.readFile(sessionFile, "utf-8");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          type?: string;
          message?: { role?: string; content?: unknown };
        },
    )
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message as { role?: string; content?: unknown });
};
describe("buildEmbeddedSandboxInfo", () => {
  it("returns undefined when sandbox is missing", () => {
    expect(buildEmbeddedSandboxInfo()).toBeUndefined();
  });

  it("maps sandbox context into prompt info", () => {
    const sandbox = {
      enabled: true,
      sessionKey: "session:test",
      workspaceDir: "/tmp/clawdbot-sandbox",
      agentWorkspaceDir: "/tmp/clawdbot-workspace",
      workspaceAccess: "none",
      containerName: "clawdbot-sbx-test",
      containerWorkdir: "/workspace",
      docker: {
        image: "clawdbot-sandbox:bookworm-slim",
        containerPrefix: "clawdbot-sbx-",
        workdir: "/workspace",
        readOnlyRoot: true,
        tmpfs: ["/tmp"],
        network: "none",
        user: "1000:1000",
        capDrop: ["ALL"],
        env: { LANG: "C.UTF-8" },
      },
      tools: {
        allow: ["bash"],
        deny: ["browser"],
      },
      browserAllowHostControl: true,
      browser: {
        controlUrl: "http://localhost:9222",
        noVncUrl: "http://localhost:6080",
        containerName: "clawdbot-sbx-browser-test",
      },
    } satisfies SandboxContext;

    expect(buildEmbeddedSandboxInfo(sandbox)).toEqual({
      enabled: true,
      workspaceDir: "/tmp/clawdbot-sandbox",
      workspaceAccess: "none",
      agentWorkspaceMount: undefined,
      browserControlUrl: "http://localhost:9222",
      browserNoVncUrl: "http://localhost:6080",
      hostBrowserAllowed: true,
    });
  });

  it("includes elevated info when allowed", () => {
    const sandbox = {
      enabled: true,
      sessionKey: "session:test",
      workspaceDir: "/tmp/clawdbot-sandbox",
      agentWorkspaceDir: "/tmp/clawdbot-workspace",
      workspaceAccess: "none",
      containerName: "clawdbot-sbx-test",
      containerWorkdir: "/workspace",
      docker: {
        image: "clawdbot-sandbox:bookworm-slim",
        containerPrefix: "clawdbot-sbx-",
        workdir: "/workspace",
        readOnlyRoot: true,
        tmpfs: ["/tmp"],
        network: "none",
        user: "1000:1000",
        capDrop: ["ALL"],
        env: { LANG: "C.UTF-8" },
      },
      tools: {
        allow: ["bash"],
        deny: ["browser"],
      },
      browserAllowHostControl: false,
    } satisfies SandboxContext;

    expect(
      buildEmbeddedSandboxInfo(sandbox, {
        enabled: true,
        allowed: true,
        defaultLevel: "on",
      }),
    ).toEqual({
      enabled: true,
      workspaceDir: "/tmp/clawdbot-sandbox",
      workspaceAccess: "none",
      agentWorkspaceMount: undefined,
      hostBrowserAllowed: false,
      elevated: { allowed: true, defaultLevel: "on" },
    });
  });
});

describe("resolveSessionAgentIds", () => {
  const cfg = {
    agents: {
      list: [{ id: "main" }, { id: "beta", default: true }],
    },
  } as ClawdbotConfig;

  it("falls back to the configured default when sessionKey is missing", () => {
    const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
      config: cfg,
    });
    expect(defaultAgentId).toBe("beta");
    expect(sessionAgentId).toBe("beta");
  });

  it("falls back to the configured default when sessionKey is non-agent", () => {
    const { sessionAgentId } = resolveSessionAgentIds({
      sessionKey: "telegram:slash:123",
      config: cfg,
    });
    expect(sessionAgentId).toBe("beta");
  });

  it("falls back to the configured default for global sessions", () => {
    const { sessionAgentId } = resolveSessionAgentIds({
      sessionKey: "global",
      config: cfg,
    });
    expect(sessionAgentId).toBe("beta");
  });

  it("keeps the agent id for provider-qualified agent sessions", () => {
    const { sessionAgentId } = resolveSessionAgentIds({
      sessionKey: "agent:beta:slack:channel:C1",
      config: cfg,
    });
    expect(sessionAgentId).toBe("beta");
  });

  it("uses the agent id from agent session keys", () => {
    const { sessionAgentId } = resolveSessionAgentIds({
      sessionKey: "agent:main:main",
      config: cfg,
    });
    expect(sessionAgentId).toBe("main");
  });
});

function createStubTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: "",
    parameters: Type.Object({}),
    execute: async () => ({ content: [], details: {} }),
  };
}

describe("splitSdkTools", () => {
  const tools = [
    createStubTool("read"),
    createStubTool("bash"),
    createStubTool("edit"),
    createStubTool("write"),
    createStubTool("browser"),
  ];

  it("routes all tools to customTools when sandboxed", () => {
    const { builtInTools, customTools } = splitSdkTools({
      tools,
      sandboxEnabled: true,
    });
    expect(builtInTools).toEqual([]);
    expect(customTools.map((tool) => tool.name)).toEqual([
      "read",
      "bash",
      "edit",
      "write",
      "browser",
    ]);
  });

  it("routes all tools to customTools even when not sandboxed", () => {
    const { builtInTools, customTools } = splitSdkTools({
      tools,
      sandboxEnabled: false,
    });
    expect(builtInTools).toEqual([]);
    expect(customTools.map((tool) => tool.name)).toEqual([
      "read",
      "bash",
      "edit",
      "write",
      "browser",
    ]);
  });
});

describe("createSystemPromptOverride", () => {
  it("returns the override prompt regardless of default prompt", () => {
    const override = createSystemPromptOverride("OVERRIDE");
    expect(override("DEFAULT")).toBe("OVERRIDE");
  });

  it("returns an empty string for blank overrides", () => {
    const override = createSystemPromptOverride("  \n  ");
    expect(override("DEFAULT")).toBe("");
  });
});

describe("applyGoogleTurnOrderingFix", () => {
  const makeAssistantFirst = () =>
    [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_1", name: "bash", arguments: {} },
        ],
      },
    ] satisfies AgentMessage[];

  it("prepends a bootstrap once and records a marker for Google models", () => {
    const sessionManager = SessionManager.inMemory();
    const warn = vi.fn();
    const input = makeAssistantFirst();
    const first = applyGoogleTurnOrderingFix({
      messages: input,
      modelApi: "google-generative-ai",
      sessionManager,
      sessionId: "session:1",
      warn,
    });
    expect(first.messages[0]?.role).toBe("user");
    expect(first.messages[1]?.role).toBe("assistant");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(
      sessionManager
        .getEntries()
        .some(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === "google-turn-ordering-bootstrap",
        ),
    ).toBe(true);

    applyGoogleTurnOrderingFix({
      messages: input,
      modelApi: "google-generative-ai",
      sessionManager,
      sessionId: "session:1",
      warn,
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("skips non-Google models", () => {
    const sessionManager = SessionManager.inMemory();
    const warn = vi.fn();
    const input = makeAssistantFirst();
    const result = applyGoogleTurnOrderingFix({
      messages: input,
      modelApi: "openai",
      sessionManager,
      sessionId: "session:2",
      warn,
    });
    expect(result.messages).toBe(input);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("runEmbeddedPiAgent", () => {
  it("exchanges github token for copilot token", async () => {
    const { getApiKeyForModel } = await import("./model-auth.js");
    const { resolveCopilotApiToken } = await import(
      "../providers/github-copilot-token.js"
    );

    vi.mocked(getApiKeyForModel).mockResolvedValue({
      apiKey: "gh-token",
      source: "test",
    });
    vi.mocked(resolveCopilotApiToken).mockResolvedValue({
      token: "copilot-token",
      expiresAt: Date.now() + 60_000,
      source: "test",
    });

    const agentDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdbot-agent-copilot-"),
    );
    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdbot-workspace-copilot-"),
    );
    const sessionFile = path.join(workspaceDir, "session.jsonl");

    await expect(
      runEmbeddedPiAgent({
        sessionId: "session:test",
        sessionKey: "agent:dev:test",
        sessionFile,
        workspaceDir,
        prompt: "hi",
        provider: "github-copilot",
        model: "gpt-4o",
        timeoutMs: 1,
        agentDir,
      }),
    ).rejects.toThrow();

    expect(resolveCopilotApiToken).toHaveBeenCalledWith({
      githubToken: "gh-token",
    });
  });

  it("writes models.json into the provided agentDir", async () => {
    const agentDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdbot-agent-"),
    );
    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdbot-workspace-"),
    );
    const sessionFile = path.join(workspaceDir, "session.jsonl");

    const cfg = {
      models: {
        providers: {
          minimax: {
            baseUrl: "https://api.minimax.io/v1",
            api: "openai-completions",
            apiKey: "sk-minimax-test",
            models: [
              {
                id: "minimax-m2.1",
                name: "MiniMax M2.1",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 200000,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    } satisfies ClawdbotConfig;

    await expect(
      runEmbeddedPiAgent({
        sessionId: "session:test",
        sessionKey: "agent:dev:test",
        sessionFile,
        workspaceDir,
        config: cfg,
        prompt: "hi",
        provider: "definitely-not-a-provider",
        model: "definitely-not-a-model",
        timeoutMs: 1,
        agentDir,
      }),
    ).rejects.toThrow(/Unknown model:/);

    await expect(
      fs.stat(path.join(agentDir, "models.json")),
    ).resolves.toBeTruthy();
  });

  it(
    "persists the first user message before assistant output",
    { timeout: 15_000 },
    async () => {
      const agentDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "clawdbot-agent-"),
      );
      const workspaceDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "clawdbot-workspace-"),
      );
      const sessionFile = path.join(workspaceDir, "session.jsonl");

      const cfg = makeOpenAiConfig(["mock-1"]);
      await ensureModels(cfg, agentDir);

      await runEmbeddedPiAgent({
        sessionId: "session:test",
        sessionKey: "agent:main:main",
        sessionFile,
        workspaceDir,
        config: cfg,
        prompt: "hello",
        provider: "openai",
        model: "mock-1",
        timeoutMs: 5_000,
        agentDir,
      });

      const messages = await readSessionMessages(sessionFile);
      const firstUserIndex = messages.findIndex(
        (message) =>
          message?.role === "user" &&
          textFromContent(message.content) === "hello",
      );
      const firstAssistantIndex = messages.findIndex(
        (message) => message?.role === "assistant",
      );
      expect(firstUserIndex).toBeGreaterThanOrEqual(0);
      if (firstAssistantIndex !== -1) {
        expect(firstUserIndex).toBeLessThan(firstAssistantIndex);
      }
    },
  );

  it("persists the user message when prompt fails before assistant output", async () => {
    const agentDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdbot-agent-"),
    );
    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdbot-workspace-"),
    );
    const sessionFile = path.join(workspaceDir, "session.jsonl");

    const cfg = makeOpenAiConfig(["mock-error"]);
    await ensureModels(cfg, agentDir);

    const result = await runEmbeddedPiAgent({
      sessionId: "session:test",
      sessionKey: "agent:main:main",
      sessionFile,
      workspaceDir,
      config: cfg,
      prompt: "boom",
      provider: "openai",
      model: "mock-error",
      timeoutMs: 5_000,
      agentDir,
    });
    expect(result.payloads[0]?.isError).toBe(true);

    const messages = await readSessionMessages(sessionFile);
    const userIndex = messages.findIndex(
      (message) =>
        message?.role === "user" && textFromContent(message.content) === "boom",
    );
    expect(userIndex).toBeGreaterThanOrEqual(0);
  });

  it("appends new user + assistant after existing transcript entries", async () => {
    const agentDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdbot-agent-"),
    );
    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdbot-workspace-"),
    );
    const sessionFile = path.join(workspaceDir, "session.jsonl");

    const sessionManager = SessionManager.open(sessionFile);
    sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "seed user" }],
    });
    sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "seed assistant" }],
      stopReason: "stop",
      api: "openai-responses",
      provider: "openai",
      model: "mock-1",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      timestamp: Date.now(),
    });

    const cfg = makeOpenAiConfig(["mock-1"]);
    await ensureModels(cfg, agentDir);

    await runEmbeddedPiAgent({
      sessionId: "session:test",
      sessionKey: "agent:main:main",
      sessionFile,
      workspaceDir,
      config: cfg,
      prompt: "hello",
      provider: "openai",
      model: "mock-1",
      timeoutMs: 5_000,
      agentDir,
    });

    const messages = await readSessionMessages(sessionFile);
    const seedUserIndex = messages.findIndex(
      (message) =>
        message?.role === "user" &&
        textFromContent(message.content) === "seed user",
    );
    const seedAssistantIndex = messages.findIndex(
      (message) =>
        message?.role === "assistant" &&
        textFromContent(message.content) === "seed assistant",
    );
    const newUserIndex = messages.findIndex(
      (message) =>
        message?.role === "user" &&
        textFromContent(message.content) === "hello",
    );
    const newAssistantIndex = messages.findIndex(
      (message, index) => index > newUserIndex && message?.role === "assistant",
    );
    expect(seedUserIndex).toBeGreaterThanOrEqual(0);
    expect(seedAssistantIndex).toBeGreaterThan(seedUserIndex);
    expect(newUserIndex).toBeGreaterThan(seedAssistantIndex);
    expect(newAssistantIndex).toBeGreaterThan(newUserIndex);
  });

  it("persists multi-turn user/assistant ordering across runs", async () => {
    const agentDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdbot-agent-"),
    );
    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdbot-workspace-"),
    );
    const sessionFile = path.join(workspaceDir, "session.jsonl");

    const cfg = makeOpenAiConfig(["mock-1"]);
    await ensureModels(cfg, agentDir);

    await runEmbeddedPiAgent({
      sessionId: "session:test",
      sessionKey: "agent:main:main",
      sessionFile,
      workspaceDir,
      config: cfg,
      prompt: "first",
      provider: "openai",
      model: "mock-1",
      timeoutMs: 5_000,
      agentDir,
    });

    await runEmbeddedPiAgent({
      sessionId: "session:test",
      sessionKey: "agent:main:main",
      sessionFile,
      workspaceDir,
      config: cfg,
      prompt: "second",
      provider: "openai",
      model: "mock-1",
      timeoutMs: 5_000,
      agentDir,
    });

    const messages = await readSessionMessages(sessionFile);
    const firstUserIndex = messages.findIndex(
      (message) =>
        message?.role === "user" &&
        textFromContent(message.content) === "first",
    );
    const firstAssistantIndex = messages.findIndex(
      (message, index) =>
        index > firstUserIndex && message?.role === "assistant",
    );
    const secondUserIndex = messages.findIndex(
      (message) =>
        message?.role === "user" &&
        textFromContent(message.content) === "second",
    );
    const secondAssistantIndex = messages.findIndex(
      (message, index) =>
        index > secondUserIndex && message?.role === "assistant",
    );
    expect(firstUserIndex).toBeGreaterThanOrEqual(0);
    expect(firstAssistantIndex).toBeGreaterThan(firstUserIndex);
    expect(secondUserIndex).toBeGreaterThan(firstAssistantIndex);
    expect(secondAssistantIndex).toBeGreaterThan(secondUserIndex);
  });
||||||| parent of 3da1afed6 (feat: add GitHub Copilot provider)

  it("persists the first user message before assistant output", async () => {
    const agentDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdbot-agent-"),
    );
    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdbot-workspace-"),
    );
    const sessionFile = path.join(workspaceDir, "session.jsonl");

    const cfg = makeOpenAiConfig(["mock-1"]);

    await runEmbeddedPiAgent({
      sessionId: "session:test",
      sessionKey: "agent:main:main",
      sessionFile,
      workspaceDir,
      config: cfg,
      prompt: "hello",
      provider: "openai",
      model: "mock-1",
      timeoutMs: 5_000,
      agentDir,
    });

    const messages = await readSessionMessages(sessionFile);
    const firstUserIndex = messages.findIndex(
      (message) =>
        message?.role === "user" &&
        textFromContent(message.content) === "hello",
    );
    const firstAssistantIndex = messages.findIndex(
      (message) => message?.role === "assistant",
    );
    expect(firstUserIndex).toBeGreaterThanOrEqual(0);
    if (firstAssistantIndex !== -1) {
      expect(firstUserIndex).toBeLessThan(firstAssistantIndex);
    }
  });

  it("persists the user message when prompt fails before assistant output", async () => {
    const agentDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdbot-agent-"),
    );
    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdbot-workspace-"),
    );
    const sessionFile = path.join(workspaceDir, "session.jsonl");

    const cfg = makeOpenAiConfig(["mock-error"]);

    const result = await runEmbeddedPiAgent({
      sessionId: "session:test",
      sessionKey: "agent:main:main",
      sessionFile,
      workspaceDir,
      config: cfg,
      prompt: "boom",
      provider: "openai",
      model: "mock-error",
      timeoutMs: 5_000,
      agentDir,
    });
    expect(result.payloads[0]?.isError).toBe(true);

    const messages = await readSessionMessages(sessionFile);
    const userIndex = messages.findIndex(
      (message) =>
        message?.role === "user" && textFromContent(message.content) === "boom",
    );
    expect(userIndex).toBeGreaterThanOrEqual(0);
  });

  it("appends new user + assistant after existing transcript entries", async () => {
    const agentDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdbot-agent-"),
    );
    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdbot-workspace-"),
    );
    const sessionFile = path.join(workspaceDir, "session.jsonl");

    const sessionManager = SessionManager.open(sessionFile);
    sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "seed user" }],
    });
    sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "seed assistant" }],
      stopReason: "stop",
      api: "openai-responses",
      provider: "openai",
      model: "mock-1",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      timestamp: Date.now(),
    });

    const cfg = makeOpenAiConfig(["mock-1"]);

    await runEmbeddedPiAgent({
      sessionId: "session:test",
      sessionKey: "agent:main:main",
      sessionFile,
      workspaceDir,
      config: cfg,
      prompt: "hello",
      provider: "openai",
      model: "mock-1",
      timeoutMs: 5_000,
      agentDir,
    });

    const messages = await readSessionMessages(sessionFile);
    const seedUserIndex = messages.findIndex(
      (message) =>
        message?.role === "user" &&
        textFromContent(message.content) === "seed user",
    );
    const seedAssistantIndex = messages.findIndex(
      (message) =>
        message?.role === "assistant" &&
        textFromContent(message.content) === "seed assistant",
    );
    const newUserIndex = messages.findIndex(
      (message) =>
        message?.role === "user" &&
        textFromContent(message.content) === "hello",
    );
    const newAssistantIndex = messages.findIndex(
      (message, index) => index > newUserIndex && message?.role === "assistant",
    );
    expect(seedUserIndex).toBeGreaterThanOrEqual(0);
    expect(seedAssistantIndex).toBeGreaterThan(seedUserIndex);
    expect(newUserIndex).toBeGreaterThan(seedAssistantIndex);
    expect(newAssistantIndex).toBeGreaterThan(newUserIndex);
  });

  it("persists multi-turn user/assistant ordering across runs", async () => {
    const agentDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdbot-agent-"),
    );
    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdbot-workspace-"),
    );
    const sessionFile = path.join(workspaceDir, "session.jsonl");

    const cfg = makeOpenAiConfig(["mock-1"]);

    await runEmbeddedPiAgent({
      sessionId: "session:test",
      sessionKey: "agent:main:main",
      sessionFile,
      workspaceDir,
      config: cfg,
      prompt: "first",
      provider: "openai",
      model: "mock-1",
      timeoutMs: 5_000,
      agentDir,
    });

    await runEmbeddedPiAgent({
      sessionId: "session:test",
      sessionKey: "agent:main:main",
      sessionFile,
      workspaceDir,
      config: cfg,
      prompt: "second",
      provider: "openai",
      model: "mock-1",
      timeoutMs: 5_000,
      agentDir,
    });

    const messages = await readSessionMessages(sessionFile);
    const firstUserIndex = messages.findIndex(
      (message) =>
        message?.role === "user" &&
        textFromContent(message.content) === "first",
    );
    const firstAssistantIndex = messages.findIndex(
      (message, index) =>
        index > firstUserIndex && message?.role === "assistant",
    );
    const secondUserIndex = messages.findIndex(
      (message) =>
        message?.role === "user" &&
        textFromContent(message.content) === "second",
    );
    const secondAssistantIndex = messages.findIndex(
      (message, index) =>
        index > secondUserIndex && message?.role === "assistant",
    );
    expect(firstUserIndex).toBeGreaterThanOrEqual(0);
    expect(firstAssistantIndex).toBeGreaterThan(firstUserIndex);
    expect(secondUserIndex).toBeGreaterThan(firstAssistantIndex);
    expect(secondAssistantIndex).toBeGreaterThan(secondUserIndex);
  });
});
