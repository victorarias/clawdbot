# Claude SDK vs Embedded Runner Gaps (Heartbeat Focus)

## Prompt differences (in progress)
- SDK vs embedded tool naming differs in the prompt: SDK uses MCP-prefixed tool names (`mcp__clawdbot-tools__*`); embedded uses native names (`read`, `exec`, `message`, etc.).

## Other integration gaps found
- Skills:
  - Embedded loads workspace skills, applies skill env overrides, and builds `skillsPrompt`.
  - SDK previously did not; now being aligned to load skills and build prompt.
- Sandbox:
  - Embedded resolves sandbox context, adjusts workspace path/permissions, and passes `sandboxInfo` to system prompt.
  - SDK previously did not; now being aligned to include sandbox info.
- Tool defaults / exec policy:
  - Embedded passes `resolveExecToolDefaults(...)`, `bashElevated`, and `modelAuthMode` to `createClawdbotCodingTools`.
  - SDK now passes `resolveExecToolDefaults(...)`, sandbox, `modelAuthMode`, and `bashElevated`.
- Bootstrap context truncation:
  - Embedded uses `buildBootstrapContextFiles(..., { maxChars, warn })`.
  - SDK previously did not; now being aligned to include truncation limits.
- Model params:
  - Embedded applies `applyExtraParamsToAgent(...)` (temperature/maxTokens, etc.).
  - SDK does not apply config-driven model params (accepted limitation for now).
- Extensions / session infra:
  - Embedded uses `SessionManager`, `SettingsManager`, compaction reserves, and `buildEmbeddedExtensionPaths(...)`.
  - SDK path does not use session file infra, compaction, or extension paths (leaving as-is for now).
- Final tag enforcement:
  - Embedded can enforce `<final>` tagging via `enforceFinalTag` for some providers.
  - SDK now enforces `<final>` tags when requested.

## Follow-up work
- Align SDK runner inputs to `buildAgentSystemPrompt` with embedded runner (reasoning, skills, sandbox, runtime info).
- Decide how to handle tool naming differences in the prompt (MCP-prefixed vs native names).
- Decide whether SDK runner should resolve sandbox + skills + bootstrap truncation for parity.
- Decide whether SDK runner should apply extra model params and compaction/extension behaviors.
