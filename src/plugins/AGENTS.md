# Plugins Module

Plugin extension system with 3-tier auto-discovery (bundled/global/workspace). Provides `PluginApi` for registering tools, hooks, and services. Lightweight, no build step.

## STRUCTURE

```
plugins/
├── index.ts           # definePlugin(), registerPlugin(), activatePlugin(), PluginApi class, 15+ type interfaces
├── loader.ts          # loadPlugins() → resolveEnableState() → module import → register; activateAllPlugins()
├── discovery.ts       # discoverPlugins() — filesystem scan for vex.plugin.json, package.json, index.ts
└── service.ts         # PluginService orchestrator: initialize() → loadPlugins() → activateAllPlugins()
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Plugin definition shape | `index.ts` | `PluginDefinition`: `meta`, `configSchema`, `register`, `activate`, `cleanup` |
| PluginApi surface | `index.ts` | `registerTool`, `registerTools`, `registerHook`, `registerService`, `getLogger`, `getStateDir` |
| Define a plugin | `index.ts` | `definePlugin(meta, init, cleanup?)` helper; also `defineToolPlugin(meta, tools)` |
| Load plugins from disk | `loader.ts` | `loadPlugins(config, enableConfig)` → discover + resolveEnableState + import + register |
| 3-tier filesystem scan | `discovery.ts` | Scans bundled/global/workspace paths; priority: workspace > global > bundled |
| Orchestrated init | `service.ts` | `PluginService.initialize()` — combined load + activate with result reporting |
| Enable/disable filtering | `loader.ts:resolveEnableState()` | allow/deny/slots/entries — resolves per-plugin enabled boolean |
| Lifecycle events | `index.ts` | `register` (sync, register tools/hooks), `activate` (async, start services), `cleanup` (teardown) |

## CONVENTIONS

- `definePlugin(meta, init, cleanup?)` creates a `PluginDefinition` with `register = init`
- `PluginApi.registerTool()` wraps `tools/registry.ts` `registerTool()` — same contract
- `PluginApi.registerHook()` wraps `hooks/index.ts` `registerHook()` — returns unsubscribe function
- `discoverPlugins()` scans `CWD/plugins/` (bundled), `~/.vex/plugins/` (global), `CWD/.vex/plugins/` (workspace)
- Later tiers override earlier: workspace > global > bundled (same plugin ID wins)
- Each plugin directory needs one of: `vex.plugin.json`, `package.json` with `vex.plugin` field, or `index.ts`/`index.js`
- `PluginService.initialize()` returns `{ loaded, activated, skipped, failed }` arrays

## ANTI-PATTERNS

- **NEVER call `registerPlugin()` after `Gateway.initialize()`** — tools must be registered before Agent starts
- **NEVER import plugin internals directly** — use `PluginApi` methods for tool/hook registration
- **NEVER assume `PluginService` auto-runs** — it is NOT wired into Gateway startup; call `initialize()` manually
