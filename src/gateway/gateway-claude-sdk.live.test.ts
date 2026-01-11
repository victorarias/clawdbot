import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parseModelRef } from "../agents/model-selection.js";
import { loadConfig } from "../config/config.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../utils/message-provider.js";
import { GatewayClient } from "./client.js";
import { startGatewayServer } from "./server.js";

const LIVE = process.env.LIVE === "1" || process.env.CLAWDBOT_LIVE_TEST === "1";
const CLAUDE_SDK_LIVE = process.env.CLAWDBOT_LIVE_CLAUDE_SDK_GATEWAY === "1";
const ENABLED = LIVE && CLAUDE_SDK_LIVE;

const DEFAULT_MODEL = "claude-sdk/claude-opus-4-5";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, "__fixtures__");
const RECORD_PATH = path.join(FIXTURE_DIR, "claude-sdk-gateway-live.json");

type Recording = {
  createdAt: string;
  provider: string;
  model: string;
  prompt: string;
  probeContent: string;
  responseText: string;
};

const hasRecording = fs.existsSync(RECORD_PATH);
const describeLive = ENABLED || hasRecording ? describe : describe.skip;

type AgentFinalPayload = {
  status?: unknown;
  result?: unknown;
};

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("failed to acquire free port"));
        return;
      }
      const port = addr.port;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

async function isPortFree(port: number): Promise<boolean> {
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return false;
  return await new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => {
      srv.close(() => resolve(true));
    });
  });
}

async function getFreeGatewayPort(): Promise<number> {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const port = await getFreePort();
    const candidates = [port, port + 1, port + 2, port + 4];
    const ok = (
      await Promise.all(candidates.map((candidate) => isPortFree(candidate)))
    ).every(Boolean);
    if (ok) return port;
  }
  throw new Error("failed to acquire a free gateway port block");
}

async function connectClient(params: { url: string; token: string }) {
  return await new Promise<GatewayClient>((resolve, reject) => {
    let settled = false;
    const stop = (err?: Error, client?: GatewayClient) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(client as GatewayClient);
    };
    const client = new GatewayClient({
      url: params.url,
      token: params.token,
      clientName: GATEWAY_CLIENT_NAMES.TEST,
      clientDisplayName: "vitest-live-claude-sdk",
      clientVersion: "dev",
      mode: GATEWAY_CLIENT_MODES.TEST,
      onHelloOk: () => stop(undefined, client),
      onConnectError: (err) => stop(err),
      onClose: (code, reason) =>
        stop(new Error(`gateway closed during connect (${code}): ${reason}`)),
    });
    const timer = setTimeout(
      () => stop(new Error("gateway connect timeout")),
      10_000,
    );
    timer.unref();
    client.start();
  });
}

function extractPayloadText(result: unknown): string {
  const record = result as Record<string, unknown>;
  const payloads = Array.isArray(record.payloads) ? record.payloads : [];
  const texts = payloads
    .map((p) =>
      p && typeof p === "object"
        ? (p as Record<string, unknown>).text
        : undefined,
    )
    .filter((t): t is string => typeof t === "string" && t.trim().length > 0);
  return texts.join("\n").trim();
}

describeLive("gateway live (claude-sdk)", () => {
  it("runs the gateway agent pipeline with Claude Agent SDK", async () => {
    const previous = {
      configPath: process.env.CLAWDBOT_CONFIG_PATH,
      token: process.env.CLAWDBOT_GATEWAY_TOKEN,
      skipProviders: process.env.CLAWDBOT_SKIP_PROVIDERS,
      skipGmail: process.env.CLAWDBOT_SKIP_GMAIL_WATCHER,
      skipCron: process.env.CLAWDBOT_SKIP_CRON,
      skipCanvas: process.env.CLAWDBOT_SKIP_CANVAS_HOST,
    };

    process.env.CLAWDBOT_SKIP_PROVIDERS = "1";
    process.env.CLAWDBOT_SKIP_GMAIL_WATCHER = "1";
    process.env.CLAWDBOT_SKIP_CRON = "1";
    process.env.CLAWDBOT_SKIP_CANVAS_HOST = "1";

    const token = `test-${randomUUID()}`;
    process.env.CLAWDBOT_GATEWAY_TOKEN = token;

    const rawModel =
      process.env.CLAWDBOT_LIVE_CLAUDE_SDK_MODEL ?? DEFAULT_MODEL;
    const parsed = parseModelRef(rawModel, "claude-sdk");
    if (!parsed || parsed.provider !== "claude-sdk") {
      throw new Error(
        `CLAWDBOT_LIVE_CLAUDE_SDK_MODEL must resolve to a claude-sdk model. Got: ${rawModel}`,
      );
    }
    const modelKey = `${parsed.provider}/${parsed.model}`;
    const modelId = parsed.model;

    if (!ENABLED) {
      if (!hasRecording) {
        return;
      }
      const raw = await fsPromises.readFile(RECORD_PATH, "utf8");
      const recording = JSON.parse(raw) as Recording;
      expect(recording.responseText).toContain(recording.probeContent);
      return;
    }

    const tempDir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "clawdbot-live-claude-sdk-"),
    );
    const workspaceDir = path.join(tempDir, "workspace");
    await fsPromises.mkdir(workspaceDir, { recursive: true });

    const probeNonce = randomUUID();
    const probePath = path.join(
      workspaceDir,
      `.clawdbot-live-claude-sdk.${probeNonce}.txt`,
    );
    const probeContent = `claude-sdk gateway live probe: ${probeNonce}`;
    await fsPromises.writeFile(probePath, `${probeContent}\n`);

    const cfg = loadConfig();
    const nextCfg = {
      ...cfg,
      agents: {
        ...cfg.agents,
        list: (cfg.agents?.list ?? []).map((entry) => ({
          ...entry,
          sandbox: { mode: "off" },
        })),
        defaults: {
          ...cfg.agents?.defaults,
          model: { primary: modelKey },
          models: {
            [modelKey]: {},
          },
          workspace: workspaceDir,
          sandbox: { mode: "off" },
        },
      },
    };
    const tempConfigPath = path.join(tempDir, "clawdbot.json");
    await fsPromises.writeFile(
      tempConfigPath,
      `${JSON.stringify(nextCfg, null, 2)}\n`,
    );
    process.env.CLAWDBOT_CONFIG_PATH = tempConfigPath;

    const port = await getFreeGatewayPort();
    const server = await startGatewayServer(port, {
      bind: "loopback",
      auth: { mode: "token", token },
      controlUiEnabled: false,
    });

    const client = await connectClient({
      url: `ws://127.0.0.1:${port}`,
      token,
    });

    try {
      const sessionKey = "agent:dev:live-claude-sdk";
      const runId = randomUUID();
      const prompt =
        "Clawdbot live tool probe (local, safe): " +
        "use the tool named `mcp__clawdbot-tools__read` with JSON arguments " +
        `{"path":"${probePath}"}. Then reply with the exact file contents only.`;

      const payload = await client.request<AgentFinalPayload>(
        "agent",
        {
          sessionKey,
          idempotencyKey: `idem-${runId}`,
          message: prompt,
          deliver: false,
        },
        { expectFinal: true },
      );
      if (payload?.status !== "ok") {
        throw new Error(`agent status=${String(payload?.status)}`);
      }
      const text = extractPayloadText(payload?.result);
      expect(text).toContain(probeContent);

      const recording: Recording = {
        createdAt: new Date().toISOString(),
        provider: "claude-sdk",
        model: modelId,
        prompt,
        probeContent,
        responseText: text,
      };
      await fsPromises.mkdir(FIXTURE_DIR, { recursive: true });
      await fsPromises.writeFile(
        RECORD_PATH,
        `${JSON.stringify(recording, null, 2)}\n`,
        "utf8",
      );
    } finally {
      await server.close({ reason: "test done" });
      process.env.CLAWDBOT_CONFIG_PATH = previous.configPath;
      process.env.CLAWDBOT_GATEWAY_TOKEN = previous.token;
      process.env.CLAWDBOT_SKIP_PROVIDERS = previous.skipProviders;
      process.env.CLAWDBOT_SKIP_GMAIL_WATCHER = previous.skipGmail;
      process.env.CLAWDBOT_SKIP_CRON = previous.skipCron;
      process.env.CLAWDBOT_SKIP_CANVAS_HOST = previous.skipCanvas;
    }
  }, 30_000);
});
