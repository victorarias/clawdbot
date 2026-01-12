import { describe, expect, it } from "vitest";

import { stripHeartbeatToken } from "./heartbeat.js";
import { HEARTBEAT_TOKEN } from "./tokens.js";

describe("stripHeartbeatToken", () => {
  it("skips empty or token-only replies", () => {
    expect(stripHeartbeatToken(undefined, { mode: "heartbeat" })).toEqual({
      shouldSkip: true,
      text: "",
      didStrip: false,
    });
    expect(stripHeartbeatToken("  ", { mode: "heartbeat" })).toEqual({
      shouldSkip: true,
      text: "",
      didStrip: false,
    });
    expect(stripHeartbeatToken(HEARTBEAT_TOKEN, { mode: "heartbeat" })).toEqual(
      {
        shouldSkip: true,
        text: "",
        didStrip: true,
      },
    );
  });

  it("drops heartbeats with small junk in heartbeat mode", () => {
    expect(
      stripHeartbeatToken("HEARTBEAT_OK 🦞", { mode: "heartbeat" }),
    ).toEqual({
      shouldSkip: true,
      text: "",
      didStrip: true,
    });
    expect(
      stripHeartbeatToken(`🦞 ${HEARTBEAT_TOKEN}`, { mode: "heartbeat" }),
    ).toEqual({
      shouldSkip: true,
      text: "",
      didStrip: true,
    });
  });

  it("drops short remainder in heartbeat mode", () => {
    expect(
      stripHeartbeatToken(`ALERT ${HEARTBEAT_TOKEN}`, { mode: "heartbeat" }),
    ).toEqual({
      shouldSkip: true,
      text: "",
      didStrip: true,
    });
  });

  it("keeps heartbeat replies when remaining content exceeds threshold", () => {
    const long = "A".repeat(31);
    expect(
      stripHeartbeatToken(`${long} ${HEARTBEAT_TOKEN}`, { mode: "heartbeat" }),
    ).toEqual({
      shouldSkip: false,
      text: long,
      didStrip: true,
    });
  });

  it("delivers verbose heartbeat responses (agent must reply with ONLY HEARTBEAT_OK)", () => {
    // This documents the expected behavior: when an agent adds commentary
    // before HEARTBEAT_OK, the message WILL be delivered because the remaining
    // text exceeds the 30-char threshold. The agent should reply with ONLY
    // "HEARTBEAT_OK" when nothing needs attention.
    const verboseResponse =
      "It's 8am in Stockholm. Nothing urgent. HEARTBEAT_OK";
    const result = stripHeartbeatToken(verboseResponse, { mode: "heartbeat" });
    expect(result.shouldSkip).toBe(false); // Will be delivered!
    expect(result.text).toBe("It's 8am in Stockholm. Nothing urgent.");
    expect(result.didStrip).toBe(true);
  });

  it("strips token at edges for normal messages", () => {
    expect(
      stripHeartbeatToken(`${HEARTBEAT_TOKEN} hello`, { mode: "message" }),
    ).toEqual({
      shouldSkip: false,
      text: "hello",
      didStrip: true,
    });
    expect(
      stripHeartbeatToken(`hello ${HEARTBEAT_TOKEN}`, { mode: "message" }),
    ).toEqual({
      shouldSkip: false,
      text: "hello",
      didStrip: true,
    });
  });

  it("does not touch token in the middle", () => {
    expect(
      stripHeartbeatToken(`hello ${HEARTBEAT_TOKEN} there`, {
        mode: "message",
      }),
    ).toEqual({
      shouldSkip: false,
      text: `hello ${HEARTBEAT_TOKEN} there`,
      didStrip: false,
    });
  });
});
