# Agents Module

Core Agent orchestration layer. Wraps `@mariozechner/pi-coding-agent` (`AgentSession`, `SessionManager`, `AuthStorage`, `ModelRegistry`) and `@mariozechner/pi-agent-core` (`AgentTool`). Creates `Agent` instances wired with tools, skills, memory, and cron.

## STRUCTURE

```
agents/
├── agent.ts          # Agent class, AgentOptions, AgentResponse, ToolCallResult, createAgent()
├── runtime.ts        # AgentRuntime (chat/chatStream, session lifecycle, tool registration)
├── system-prompt.ts  # buildSystemPrompt(): environment, tools, skills, memory, output formatting
└── index.ts          # Barrel: re-exports agent.ts + runtime.ts + system-prompt.ts
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Factory wiring order | `agent.ts:createAgent()` | MemoryManager → AgentRuntime → CronService → Agent → SkillsRegistry |
| Message processing entry | `agent.ts:Agent.processMessage()` | Non-streaming; delegates to `runtime.chat()` |
| Streaming response | `agent.ts:Agent.processMessageStream()` | AsyncGenerator; yields text_delta, tool_start, tool_end |
| Tool initialization | `agent.ts:Agent.initializeTools()` | `createBuiltinTools()` → register each tool on runtime |
| Session lifecycle | `runtime.ts:AgentRuntime` | getOrCreateSession, clearSession, shutdown |
| Per-session serialization | `runtime.ts:lockSession()` | Exclusive per-sessionKey lock; chat/chatStream run one turn at a time per key |
| pi-coding-agent wiring | `runtime.ts:getOrCreateSession()` | SessionManager, AuthStorage, ModelRegistry, createAgentSession |
| API key injection | `runtime.ts:getOrCreateSession()` | AuthStorage from `getApiKeyForProvider()` + fallback resolver |
| System prompt assembly | `system-prompt.ts:buildSystemPrompt()` | basePrompt → environment → tool rules → skills → memory → output format |
| Chat bypass (CLI) | `src/cli/index.ts:chat` | Constructs pi-ai messages directly; does NOT use Agent |
| Session key derivation | `runtime.ts:getSessionKey()` | `channelId:chatId` for groups, `channelId:senderId` for DM |
| Model resolution | `runtime.ts:getOrCreateSession()` | `resolveModel(provider, model)` → `createAgentSession()` |

## KEY PATTERNS

**Wiring order in createAgent()**:
1. Lazy-load `MemoryManager` via dynamic `import("../memory/index.js")`
2. `createAgentRuntime(config)` → AgentRuntime with sessions, API keys, system prompt
3. `createDefaultCronExecuteJob()` wrapping `runtime.chat()` as agent executor
4. `getCronService()` + `cronService.start()` — cron STARTS here, before Gateway init
5. `new Agent(runtime, options)` — tools initialized in constructor
6. `initSkills(config.skills)` → `agent.setSkillsRegistry(registry)` — skills loaded last

**System prompt assembly**: `buildSystemPrompt()` layers: basePrompt → environment block → tool rules (if tools array passed) → file/browser/memory guides → skillsPrompt → output format guide → additionalContext. Memory guide injected even without memory tools if `enableMemory` flag is set.

**Chinese-language rules**: `system-prompt.ts` injects hard-coded Chinese behavioral directives into every session's system prompt via `buildOutputFormatGuide()`, `buildMemoryGuide()`, and the default basePrompt.

**Session isolation**: Each `(channelId, chatId/senderId)` pair gets a separate `AgentSession` with its own `SessionManager` (persisted to `~/.vex/sessions/<key>.jsonl`), `AuthStorage`, and tool set.

**Stream event loop**: `chatStream()` subscribes to `AgentSessionEvent` events, queues them, then polls the queue in a 50ms loop while draining. AbortSignal terminates the loop and calls `session.agent.abort()`.

**Tool error wrapping**: `wrapErrorAwareTool()` in runtime.ts intercepts `isError` flags on `AgentToolResult` and converts them to thrown errors so pi-coding-agent surfaces them as tool failures.

## ANTI-PATTERNS

- **NEVER bypass Agent for message processing** — use `Agent.processMessage()` or `Agent.processMessageStream()`; the only exception is `src/cli/index.ts:chat`
- **NEVER modify system prompt assembly without checking injection order** — skills and memory guides are position-sensitive in the final prompt
- **NEVER call `cronService.start()` outside createAgent()** — it starts once during wiring, before Gateway
- **NEVER create AgentSession manually** — always use `AgentRuntime.getOrCreateSession()` which handles AuthStorage, ModelRegistry, and system prompt setup
- **NEVER skip `_baseSystemPrompt` override** — failing to set both `agent.setSystemPrompt()` AND `(newSession as any)._baseSystemPrompt` causes `prompt()` to reset the prompt
- **NEVER use `this.config.provider` for pi-coding-agent API key lookup** — model.provider set by `resolveModel()` may differ; set API keys for both
