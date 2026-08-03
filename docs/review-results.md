# Review Result — Integration Part 4/4: PluginService wiring — IMPLEMENTATION

**Status:** ✅ **Approved. Part 4 lands; this closes out the entire 4-part integration-gaps plan.**

## What was verified

- Real plugin fixture files written to disk and dynamically imported (not mocked away) in the wiring tests.
- Per-user state-dir isolation proven via the plugin's own `register()` call reading `api.getStateDir()` (not assumed from construction).
- `customTools` checked against the actual spied `AgentRuntime` constructor args — the merge `[...createBuiltinTools(...), ...pluginToolRegistry.getAll()]` is the exact list handed to the runtime.
- Matches the confirmed design exactly, including the `activateAll()` correction from the design round (`loadFromCandidates` is the only new method; `activateAll()` was already public).
- 743/743 tests green, `tsc --noEmit` clean, `npm run build` succeeds.

## Follow-up (known, non-blocking)

`tool_start` / `tool_end` hooks are still unemitted — deferred when `hooks/` was built, waiting on `plugins/` to land (which it now has), but nobody wired the emit calls (needs `PiAgent.setBeforeToolCall`/`setAfterToolCall` wired to pi-coding-agent's hooks). Recorded in the living docs as a known follow-up.

## Arc of this session

memory/, skills/, plugins/ — three fully-built, fully-tested, fully-reviewed modules that were silently disconnected from the running system — are now actually live. From "I sent a message and got nothing back" → three real bugs fixed (logger init order, silent LLM failures, dead session titles) → a systematic sweep that found three dormant subsystems, now wired in.
