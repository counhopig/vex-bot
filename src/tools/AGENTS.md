# Tools Module

Tool registration, validation, and execution engine. 25 built-in tools across categories: filesystem, bash, web, browser, cron, memory, subagent, system.

## STRUCTURE

```
tools/
├── types.ts           # Tool interface, ToolRegistry types
├── registry.ts        # Registration/de-registration, tool lookup
├── common.ts          # Shared helpers (cwd resolution, path validation)
├── index.ts           # Barrel
└── builtin/           # 25 built-in tool implementations
    ├── filesystem.ts  # read_file, write_file, edit_file, list_directory, glob, grep, apply_patch
    ├── bash.ts        # bash, process manager
    ├── web.ts         # web_search, web_fetch
    ├── browser.ts     # browser automation (Playwright)
    ├── image.ts       # image_analyze (vision models)
    ├── cron.ts        # cron_list, cron_add, cron_remove, cron_run, cron_update
    ├── memory.ts      # memory_store, memory_query, memory_list
    ├── subagent.ts    # subagent (delegated task execution)
    ├── system.ts      # current_time, calculator, delay
    ├── process-tool.ts       # Process management backend
    ├── process-registry.ts   # Process registry (PID tracking)
    └── index.ts       # Barrel: exports all built-in tool arrays
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Tool definition shape | `types.ts` | `Tool` interface: `name`, `description`, `parameters` (JSON Schema), `execute` |
| Register a tool | `registry.ts` | `registerTool(tool)`, `registerTools(tools)`, `getTool(name)` |
| Add a built-in tool | `builtin/` | Create implementation, add to barrel in `builtin/index.ts` |
| Parameter validation | Handled per-tool | Each `execute()` validates its own args |
| Filesystem paths | `common.ts` | `resolveWorkingDirectory()` + path validation |
| Process management | `builtin/process-tool.ts` + `builtin/process-registry.ts` | Spawn/kill/list background processes |
| Browser automation | `builtin/browser.ts` | Wraps Playwright, manages browser sessions, screenshots |

## CONVENTIONS

- Tools follow `AgentTool` interface from `@mariozechner/pi-agent-core`: `name`, `label`, `description`, `parameters`, `execute`
- `execute(args, context)` returns `Promise<{ content: ContentBlock[] }>`
- Each tool is self-contained in `builtin/`; no cross-tool dependencies
- Tools are registered in `Agent.initializeTools()` during startup
- Filesystem tools respect `workingDirectory` from Agent config
- Bash tool has configurable `allowedPaths` for security sandboxing

## ANTI-PATTERNS

- **NEVER add npm dependencies for trivial utilities** — prefer Node.js built-ins
- **NEVER execute user input directly in bash** — validate/escape in `common.ts`
- **NEVER expose Playwright browser to untrusted input without sanitization**
- **NEVER register tools with the same name** — registry overwrites silently
- Cron tools delegate to `CronService`; do NOT duplicate scheduling logic
