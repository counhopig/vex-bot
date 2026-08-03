# Vex Architecture

## Design Philosophy

Vex is a **general-purpose agent framework** with **Persona as its core identity mechanism**. Every agent instance is defined by its Persona — who it is, how it behaves, what it remembers. Tools, skills, and memory are capabilities that serve the Persona, not independent subsystems bolted onto a generic assistant.

### Core Principles

1. **Persona-first** — The persona defines the agent's identity. System prompts, reply styles, emotion, and memory directives all flow from persona. An agent without persona is a bare tool executor.

2. **Single dispatch path** — Every message, regardless of channel (WeChat, WebChat, CLI), flows through the same Dispatcher → Agent pipeline. No `globalAgent` vs `UserRuntimeManager` divergence.

3. **Config resolution at runtime** — System defaults (YAML) merge with user overrides (SQLite) at dispatch time. The resolved `EffectiveConfig` is the single source of truth for each `(user, channel)` tuple.

4. **Channels are dumb pipes** — Channels only translate protocols. They don't know about agents, personas, or business logic.

5. **Agent is self-contained** — An Agent instance owns its Persona, Tools, Skills, Memory, and Pipeline. No process-global state bleeding across instances.

6. **CJK-native** — Tokenization, search, and text processing work correctly for Chinese, Japanese, and Korean from day one.

---

## Top-Level Architecture

```
                          ┌─────────────────────────┐
                          │       CONFIG STORE       │
                          │  YAML (system defaults)  │
                          │  + SQLite (user override) │
                          └───────────┬─────────────┘
                                      │ resolve(user, channel)
                                      ▼
┌──────────┐  ┌──────────┐  ┌────────────────┐
│  WeChat  │  │ WebChat  │  │      CLI       │    Channels (I/O only)
│  Channel │  │ Channel  │  │    Channel     │
└────┬─────┘  └────┬─────┘  └───────┬────────┘
     │              │                │
     └──────────────┼────────────────┘
                    │ InboundMessageContext
            ┌───────▼──────────┐
            │   DISPATCHER     │   Single entry point
            │                  │   resolve(user, channel, session)
            └───────┬──────────┘
                    │ agent.processMessage(context)
                    ▼
┌───────────────────────────────────────────────────────┐
│                       AGENT                            │
│                                                       │
│  ┌─────────────────────────────────────────────────┐  │
│  │                 PERSONA                         │  │
│  │  identity │ reply style │ emotion │ memory dir │  │
│  │  profile facts │ history │ reflection          │  │
│  │                                                 │  │
│  │  → "Who the agent is"                           │  │
│  │  → System prompt base (section 1)               │  │
│  └─────────────────────────────────────────────────┘  │
│                         │                             │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐  │
│  │  Tools   │ │  Skills  │ │  Memory  │ │Pipeline│  │
│  │(能力)    │ │(行为模板)│ │(长期记忆)│ │(拦截/观察)│  │
│  └──────────┘ └──────────┘ └──────────┘ └────────┘  │
│                                                       │
│  LLM call → tool loop → response                      │
└───────────────────────────────────────────────────────┘
                    │
            ┌───────▼──────────┐
            │    OUTBOUND      │   Unified delivery
            └──────────────────┘
```

---

## Module Breakdown

### 1. Channels (`src/channels/`)

**Responsibility**: Translate between external protocols and `InboundMessageContext`.

**What it does**:
- Receive messages from external platforms
- Normalize into `InboundMessageContext` (channelId, senderId, content, timestamp, raw)
- Send responses back through the same channel
- Handle channel-specific lifecycle (connect, reconnect, health check, shutdown)

**What it does NOT do**:
- Parse or interpret message content
- Route messages to specific agents
- Manage sessions or state
- Know about persona or memory

```
Interface:
  ChannelAdapter {
    initialize(): Promise<void>
    shutdown(): Promise<void>
    sendMessage(OutboundMessage): Promise<SendResult>
    isHealthy(): Promise<boolean>
    onMessage(handler: (ctx: InboundMessageContext) => Promise<void>): void
  }
```

### 2. Dispatcher (`src/dispatcher/`)

**Responsibility**: Single entry point for all inbound messages. Resolves which Agent should handle the message.

**What it does**:
- Receives `InboundMessageContext` from any channel
- Resolves `userId` from context (channelId + senderId → web user mapping)
- Calls `ConfigStore.resolve(userId, channelId)` → `EffectiveConfig`
- Calls `AgentRegistry.getOrCreate(userId, channelId, effectiveConfig)` → `Agent`
- Routes `context` to `agent.processMessage(context)`

**What it does NOT do**:
- Process message content
- Manage LLM calls
- Handle persona or memory

```
Dispatcher {
  configStore: ConfigStore
  agentRegistry: AgentRegistry

  async dispatch(ctx: InboundMessageContext): Promise<OutboundMessage>
}
```

### 3. Agent (`src/agent/`)

**Responsibility**: The core processing unit. Owns Persona, Tools, Skills, Memory, and Pipeline. Orchestrates LLM calls.

**What it does**:
- Holds a Persona instance (identity, behavior, state)
- Holds a Tool registry (capabilities exposed to LLM)
- Holds a Skills registry (behavior templates injected into prompt)
- Holds a MemoryManager (long-term storage, per-user scoped)
- Holds a Pipeline (pre/post processing hooks)
- Builds the system prompt fresh each turn (Persona → Environment → Tools → Skills → Output Format)
- Calls the LLM (via provider abstraction)
- Runs tool loop (LLM calls tools → results fed back → LLM continues)

**Agent lifecycle**:
```
create(effectiveConfig) → Agent {
  persona: Persona | null      // null = bare tool executor
  tools: ToolRegistry
  skills: SkillsRegistry
  memory: MemoryManager
  pipeline: Pipeline
}
```

### 4. Persona (`src/agent/persona/`)

**Responsibility**: The agent's identity. Defines who the agent is, how it behaves, and what it remembers about users.

**What it does**:
- Stores identity prompt (`persona_name`, `persona_base_prompt`)
- Stores reply style (`persona_reply_style`)
- Manages per-user profile facts (auto-extracted from conversations)
- Manages emotion state (energy, mood, social need with decay/recovery)
- Manages conversation history (recent turns for context)
- Manages effects and todos
- Retrieves long-term memories relevant to current context
- Builds the persona prompt block (section 1 of system prompt)
- Issues memory directives ("you know this user", "never say you don't remember")

**What it does NOT do**:
- Execute tools
- Store long-term memory directly (delegates to MemoryManager)
- Handle message routing

```
Persona {
  config: PersonaConfig
  storage: PersonaStorage    // emotion, history, profile facts
  memory: MemoryManager      // long-term memory (delegated)

  buildPrompt(ctx: InboundMessageContext): string
  observeResponse(ctx, replyText): void
}
```

**Persona is NOT an extension.** It is a first-class component of Agent. If `config.persona` is absent or `enabled: false`, the Agent operates as a bare tool executor with a minimal default identity.

### 5. Memory (`src/memory/`)

**Responsibility**: Long-term storage and retrieval with CJK-aware search.

**What it does**:
- Store facts, notes, and conversation summaries
- Retrieve by semantic similarity (embedding + keyword hybrid)
- CJK-aware tokenization (bigram + whitespace mixed strategy)
- Per-user scoped storage (one index per user)
- Format entries for context injection

```
MemoryManager {
  store: JsonMemoryStore
  embedding: EmbeddingProvider
  tokenizer: Tokenizer        // CJK bigram + whitespace

  remember(content, metadata): Promise<string>
  recall(query, limit): Promise<MemoryEntry[]>
  list(filter): Promise<MemoryEntry[]>
  forget(id): Promise<boolean>
  formatForContext(entries): string
}
```

### 6. Tools (`src/tools/`)

**Responsibility**: Capabilities exposed to the LLM via function calling.

**What it does**:
- Register tools with name, description, parameter schema, and execute function
- Validate tool arguments before execution
- Execute tools with sandboxing (filesystem scope, bash restrictions)
- Return structured results to LLM

### 7. Skills (`src/skills/`)

**Responsibility**: Reusable behavior templates injected into the system prompt.

**What it does**:
- Parse SKILL.md files (YAML frontmatter + Markdown body)
- Auto-discover from 3 tiers (bundled → user → workspace)
- Inject relevant skill content into system prompt

### 8. Pipeline (`src/pipeline/`)

**Responsibility**: Per-Agent message pre-processing and post-processing hooks.

**What it does**:
- **Message Interceptors**: Inspect or short-circuit inbound messages before Agent processing (e.g., slash commands, spam filtering)
- **Response Observers**: React to Agent responses after processing (e.g., update persona state, trigger learning)

**What it does NOT do** (changed from current):
- The Pipeline is NOT process-global. Each Agent has its own Pipeline instance.
- Pipeline hooks do NOT need `ownerId` routing — they belong to their Agent.

```
Pipeline {
  interceptors: MessageInterceptor[]   // may return early reply
  observers: ResponseObserver[]        // fire-and-forget after reply

  async runInterceptors(ctx): Promise<string | null>
  async runObservers(ctx, reply): Promise<void>
}
```

### 9. Config Store (`src/config/`)

**Responsibility**: Resolve effective configuration for each `(user, channel)` tuple.

**Resolution order**:
```
1. Built-in defaults (hardcoded fallbacks)
2. config.local.yaml (system-level)
3. SQLite web_user_settings (user-level override)
   → EffectiveConfig(userId, channelId)
```

**Key rule**: Any code path that needs config reads from `EffectiveConfig`. There is no "global config" vs "user config" divergence.

### 10. Outbound (`src/outbound/`)

**Responsibility**: Deliver Agent responses through the appropriate channel.

**What it does**:
- Take `OutboundMessage` (content + target channel + target user)
- Route to the correct Channel adapter
- Handle delivery failures

### 11. Providers (`src/providers/`)

**Responsibility**: LLM abstraction layer. Model resolution, API key management, provider-specific quirks.

### 12. Web UI (`src/web/`)

**Responsibility**: Server-rendered control panel and WebChat interface.

**What it does**:
- WebChat SPA (inline HTML/CSS/JS, no build step)
- WebSocket protocol for real-time chat
- Control panel for config editing
- User authentication (SQLite-backed login/register)
- Per-user config persistence (`web_user_settings`)

---

## Data Flow: One Message, End to End

```
1. CHANNEL receives raw message
   WeChat: OC API long-poll → WeixinInboundMessage
   WebChat: WebSocket → JSON message

2. CHANNEL normalizes
   → InboundMessageContext {
       channelId: "weixin" | "webchat",
       senderId: "o9cq800ta...",
       content: "你好",
       timestamp: 1784634831264,
       raw: { ...originalPayload }
     }

3. CHANNEL emits to Dispatcher
   channel.onMessage(handler) → dispatcher.dispatch(ctx)

4. DISPATCHER resolves
   userId = resolveUser(ctx)              // "user_99e62ceb7e58bbbf0c9c134f"
   config = configStore.resolve(userId, "weixin")
   agent  = agentRegistry.getOrCreate(userId, "weixin", config)

5. AGENT processes
   persona.buildPrompt(ctx)               // "你是 PandaBot。用户是 counhopig..."
   memory.recall(ctx.content)             // 检索相关长期记忆
   skills.buildPrompt()                   // 注入行为模板
   effectivePrompt = buildSystemPrompt({  // 组装完整 system prompt
     persona: personaPrompt,              // Section 1 (BASE)
     environment: envInfo,                // Section 2
     tools: toolGuides,                   // Section 3
     skills: skillsPrompt,                // Section 4
     outputFormat: formatGuide            // Section 5
   })
   response = llm.chat(effectivePrompt, ctx.content, tools)
     → tool calls if needed
     → final text response

6. PIPELINE observes
   persona.observeResponse(ctx, response) // 更新 emotion, history
   memory.remember(fact)                  // 如果有关键信息

7. AGENT returns response to Dispatcher

8. DISPATCHER sends to Outbound

9. OUTBOUND delivers through Channel
   channel.sendMessage({ chatId, text: response })
```

---

## System Prompt Assembly

The system prompt is rebuilt fresh each turn because Persona state changes (history grows, emotion decays, memory updates).

```
┌─ Section 1: PERSONA (BASE) ──────────────────────────┐
│  【记忆指令】你认识这位用户，不要说"我没有记忆"         │
│  【私人 Persona】你现在扮演 PandaBot。                  │
│  你是一个友好、专业的 AI 助手。                        │
│  【回复风格】自然流畅，适度使用 emoji                   │
│  【当前时间】2026-07-22 15:30                          │
│  【用户昵称】counhopig                                 │
│  【亲密度】50/100                                      │
│  【情绪】精力充沛，心情愉悦                             │
│  【近期对话】                                          │
│    user: 我之前和你讲过什么？                           │
│    assistant: 你的名字是 counhopig...                  │
│  【长期记忆】                                          │
│    - [fact] 用户的名字是 counhopig                     │
│    - [fact] counhopig 在香港工作                       │
│  【用户画像】                                          │
│    - [姓名] 用户名字是 counhopig                       │
│    - [职业] 用户在香港工作                             │
├─ Section 2: CUSTOM INSTRUCTIONS ──────────────────────┤
│  (agent.systemPrompt — user-authored instructions)     │
│  Ordering: identity → custom instructions → environment│
├─ Section 3: ENVIRONMENT ──────────────────────────────┤
│  <environment>                                        │
│  Working directory: /home/counhopig/.vex/workspace/... │
│  Platform: linux-x64                                  │
│  Shell: zsh                                           │
│  Current time (Asia/Shanghai): 2026-07-22 15:30:00    │
│  </environment>                                       │
├─ Section 4: TOOL RULES ──────────────────────────────┤
│  ## Tool Usage Rules                                  │
│  ... file ops, bash, browser, memory guides ...       │
├─ Section 5: SKILLS ──────────────────────────────────┤
│  (injected skill content)                             │
├─ Section 6: OUTPUT FORMAT ───────────────────────────┤
│  ## Output Format                                     │
│  Use Markdown, be concise, code over description      │
└───────────────────────────────────────────────────────┘
```

**Key rule**: Persona is Section 1. Always. The LLM sees identity first, capabilities second.
`agent.systemPrompt` follows identity as Section 2 (custom instructions) and precedes the environment/tool-rules sections.

---

## Config Resolution

```
EffectiveConfig resolve(userId: string, channelId: string):

  1. Start with built-in defaults:
     {
       persona: null,           // no persona unless configured
       agent: { temperature: 0.7, maxTokens: 4096 },
       server: { port: 3000, host: "127.0.0.1" },
       ...
     }

  2. Overlay config.local.yaml (system-level):
     {
       persona: { persona_name: "PandaBot", ... },  // from YAML
       agent: { defaultProvider: "longcat", ... },
       ...
     }

  3. Overlay SQLite web_user_settings (user-level), loaded automatically via
     the injected UserConfigLoader (SqliteLoader in production) — the same
     database the control panel writes to:
     {
       persona: { persona_name: "PandaBot", ... },  // from web panel
       skillLearner: { enabled: false },
       ...
     }
     User overrides win on a per-field basis.

  4. Normalize at the EffectiveConfig boundary:
     - weather section: snake_case (YAML/UI) → typed camelCase
       (EffectiveWeatherConfig) so runtime tools receive typed options
     - memory.embeddingModel/Provider: stripped (no runtime consumer; the
       local SimpleEmbedding is fixed)
     - sessions.type: coerced to "file" (the only implemented persistence)

  5. Apply channel-specific adjustments:
     - Scoped working directory
     - Scoped memory/session directories (per-user, isPathInside-validated)
```

The tier-3 loader keeps `ConfigStore.resolve()` the single source of truth —
the Dispatcher never learns about SQLite or WebAuthStore (integration plan
design decision 2).

---

## Key Design Decisions

### 1. Persona is NOT an extension

**Why**: Extensions are optional add-ons. Persona is the core identity. Making it an extension led to it being "injected at the end" of the system prompt, after tool guides and output format — exactly backwards.

**Decision**: Persona is a first-class Agent component. If `persona.enabled: false` or absent, the Agent operates as a bare tool executor.

### 2. No globalAgent

**Why**: The current split between `globalAgent` (WeChat) and `UserRuntimeManager` (Web) means WeChat messages never get user-level config. This is the root cause of "I configured PandaBot but got 小忆".

**Decision**: The `Dispatcher` resolves the correct Agent for every message. No shortcuts.

### 3. Opt-in Persona

**Why**: Hardcoded defaults ("小忆", "温柔少女") hijack the agent when the user never asked for a persona. This violates the principle of least surprise.

**Decision**: If `persona` section is absent from config, persona is disabled. The agent uses a minimal default identity.

### 4. CJK-native tokenization

**Why**: `split(/\s+/)` fails for Chinese because there are no spaces between words. This silently breaks memory search for all CJK users.

**Decision**: Tokenizer uses bigram fallback for CJK characters: "用户名字" → ["用户", "户名", "名字"]. Combined with whitespace splitting for Latin text.

### 5. Per-Agent Pipeline

**Why**: Process-global pipeline Maps require `ownerId` gymnastics to route hooks to the right Agent instance. This is fragile and confusing.

**Decision**: Each Agent has its own Pipeline instance. When the Agent is destroyed, its Pipeline is destroyed too. No cross-instance state.

---

## Migration Path

The architecture described in this document is the **target state**. Migration from the current codebase proceeds in phases:

| Phase | Description | Breaking? |
|-------|-------------|-----------|
| 1 | Fix persona injection order (append → prepend) | No |
| 2 | Bridge SQLite persona config to WeChat via Dispatcher | No |
| 3 | Fix CJK tokenization in MemoryManager | No |
| 4 | Make persona opt-in, remove hardcoded defaults | Yes* |
| 5 | Eliminate globalAgent, introduce Dispatcher + AgentRegistry | Yes |
| 6 | Move Pipeline to per-Agent instances | Yes |

*Phase 4 removes the default "小忆" persona. Existing users who relied on the default must add `persona:` to their config.

---

## Module Dependency Graph

```
                    ┌─────────┐
                    │  Config  │
                    └────┬─────┘
                         │
          ┌──────────────┼──────────────┐
          │              │              │
    ┌─────▼─────┐  ┌────▼────┐  ┌─────▼─────┐
    │ Dispatcher│  │ Agent   │  │ Outbound  │
    └─────┬─────┘  │ Registry│  └───────────┘
          │        └────┬────┘
          │             │
          │    ┌────────┼────────┐
          │    │        │        │
          │ ┌──▼───┐ ┌──▼───┐ ┌──▼───┐
          │ │Persona│ │Tools │ │Skills│
          │ └──┬───┘ └──────┘ └──────┘
          │    │
          │ ┌──▼──────┐ ┌──────────┐
          │ │ Memory  │ │ Pipeline │
          │ └─────────┘ └──────────┘
          │
    ┌─────▼─────┐
    │ Channels  │
    │ (I/O only)│
    └───────────┘
```

- **Config** depends on nothing internal (only filesystem)
- **Dispatcher** depends on Config, AgentRegistry, Channels
- **Agent** depends on Persona, Tools, Skills, Memory, Pipeline, Providers
- **Persona** depends on Memory (delegated), Config (read-only)
- **Channels** depend on nothing internal (only external protocols)
