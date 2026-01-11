import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { loadConfig } from "../config/config.js";
import { resolveClawdbotAgentDir } from "./agent-paths.js";
import { runClaudeSdkAgent } from "./claude-sdk-runner.js";

const LIVE = process.env.LIVE === "1" || process.env.CLAWDBOT_LIVE_TEST === "1";
const ENABLED = LIVE && process.env.CLAWDBOT_LIVE_CLAUDE_SDK === "1";
const MODEL = process.env.CLAWDBOT_LIVE_CLAUDE_SDK_MODEL?.trim();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, "__fixtures__");
const RECORD_PATH = path.join(FIXTURE_DIR, "claude-sdk-live.json");

type Recording = {
  createdAt: string;
  provider: string;
  model: string;
  prompt: string;
  fileContent: string;
  responseText: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
};

const hasRecording = fs.existsSync(RECORD_PATH);
const describeSdk = ENABLED || hasRecording ? describe : describe.skip;

describeSdk("claude-sdk live (record/replay)", () => {
  it("records a tool-backed response and replays the snapshot", async () => {
    if (!ENABLED) {
      if (!hasRecording) {
        return;
      }
      const raw = await fsPromises.readFile(RECORD_PATH, "utf8");
      const recording = JSON.parse(raw) as Recording;
      expect(recording.responseText).toContain(recording.fileContent);
      return;
    }

    const tempDir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "clawdbot-claude-sdk-"),
    );
    try {
      const fileContent = "claude-sdk-live fixture: hello from clawdbot";
      const targetPath = path.join(tempDir, "sample.txt");
      await fsPromises.writeFile(targetPath, fileContent, "utf8");

      const prompt = [
        "Use the mcp__clawdbot-tools__read tool to read ./sample.txt.",
        "Reply with the exact file contents only, with no extra text.",
      ].join(" ");

      const result = await runClaudeSdkAgent({
        sessionId: randomUUID(),
        sessionFile: path.join(tempDir, "session.jsonl"),
        workspaceDir: tempDir,
        agentDir: resolveClawdbotAgentDir(),
        config: loadConfig(),
        prompt,
        provider: "claude-sdk",
        model: MODEL || "claude-opus-4-5",
        timeoutMs: 120_000,
        runId: randomUUID(),
      });

      const responseText =
        result.payloads
          ?.map((payload) => payload.text ?? "")
          .join("\n")
          .trim() ?? "";
      expect(responseText).toContain(fileContent);

      const recording: Recording = {
        createdAt: new Date().toISOString(),
        provider: "claude-sdk",
        model: MODEL || "claude-opus-4-5",
        prompt,
        fileContent,
        responseText,
        usage: result.meta.agentMeta?.usage,
      };

      await fsPromises.mkdir(FIXTURE_DIR, { recursive: true });
      await fsPromises.writeFile(
        RECORD_PATH,
        `${JSON.stringify(recording, null, 2)}\n`,
        "utf8",
      );
    } finally {
      await fsPromises.rm(tempDir, { recursive: true, force: true });
    }
  }, 180_000);
});
