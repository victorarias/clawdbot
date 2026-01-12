import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt } from "./src/agents/system-prompt.js";

describe("heartbeat prompt clarity", () => {
  it("includes explicit rules about HEARTBEAT_OK being the entire message", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/test",
      heartbeatPrompt: "Consider outstanding tasks...",
    });

    // New rules should be present
    expect(prompt).toContain("⚠️ Heartbeat rules:");
    expect(prompt).toContain("ENTIRE message");
    expect(prompt).toContain("Do NOT add commentary");
    expect(prompt).toContain("~30 chars");
    expect(prompt).toContain("❌ Wrong:");
    expect(prompt).toContain("✅ Right: HEARTBEAT_OK");
  });

  it("shows wrong example with verbose response", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/test",
      heartbeatPrompt: "Consider outstanding tasks...",
    });

    // The wrong example should show adding commentary
    expect(prompt).toContain('❌ Wrong: "It\'s 8am, nothing urgent. HEARTBEAT_OK"');
  });
});
