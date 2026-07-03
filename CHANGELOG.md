# Changelog

All notable changes to this project will be documented in this file.

This project follows semantic versioning for npm package releases.

## [Unreleased]
## [1.15.0] - 2026-07-03

### Fixed

- **Cross-user data isolation (Persona / Skill Learner):** the pipeline registries and both extensions were process-global singletons, so in multi-user mode only the *last* initialized user's persona/skill-learner state was active and one user's long-term memory could be written into another user's store. Both extensions are now containerized per owning Web user (`Map<ownerId, runtime>`); the pipeline callbacks register once and resolve the owning user's state from the message context. WebChat messages are now tagged with `__webUserId` so extensions resolve to the same runtime as the per-user `Agent`.
- **`UserRuntimeManager.getOrCreate` race:** concurrent first-touch requests for the same user could each build a duplicate `Agent` + `MemoryManager` on the same SQLite directory and leak one. The manager now caches the in-flight creation Promise so concurrent callers share a single build.
- **`vex stop` / `vex restart` whole-machine kill:** the force-kill fell back to `pkill -f "node.*dist/cli.*start"`, which matches and kills unrelated processes (other instances, editors, greps). Both commands now resolve explicit PIDs and signal them individually, never `pkill` by pattern, and exclude the current process.
- **Unbounded runtime cache:** `UserRuntimeManager` never evicted per-user runtimes, holding an `Agent` + SQLite handle + `MemoryManager` open for every user who ever logged in. It now evicts idle runtimes past a TTL and caps the live count (LRU), tearing down evicted runtimes and their extension state.
- **Memory-tool global takeover:** `createMemoryTools` still called the process-wide `setMemoryManager()` even though each tool is bound to its own manager, letting the last-created user's manager clobber the global. The global fallback has been removed entirely.

### Added

- `webAuth.secureCookies` config option. When omitted, the `Secure` attribute on the session cookie is auto-detected per request (HTTPS → `Secure`, plain HTTP/localhost → not), so it works behind a TLS-terminating proxy and in local development; set `true`/`false` to force it.

### Changed

- The Web auth SQLite connection is now cached and reused instead of being opened, schema-initialized, and closed on every request; expired-session pruning is throttled instead of running a write on every request.

## [1.14.0] - 2026-07-03

### Added

- Introduced `UserRuntimeManager` (in `src/agents/user-runtime.ts`) so authenticated Web users each get their own `Agent` and `MemoryManager`, with per-user session and long-term-memory directories scoped under `users/{userId}/`.
- Persisted user-owned runtime settings (`agent`, `memory`, `persona`, `skillLearner`, `sharelink`, `weather`, `sessions`) per Web user in the `web_user_settings` SQLite table.
- Split WebSocket `config.save` into user-owned settings (written to SQLite) and admin/system settings (still written to YAML), and added `getConfigForClient` / `saveConfigForClient` to keep user state isolated.
- Added `docs/multi-user-architecture-plan.md` describing the boundary-driven rollout of the multi-user backend.

### Changed

- Multi-user mode (default `webAuth.enabled: true`) no longer starts the process-wide Weixin channel; Weixin is now owned per Web user and dispatches inbound messages to that user's agent.
- Persona profile and memory keys are now namespaced by the owning Web user id so identical Weixin sender ids under different Vex accounts cannot collide.
- Memory tools (`search` / `store` / `list` / `delete`) now bind to the manager passed at tool-set creation, removing the process-wide `setMemoryManager()` takeover when a user-scoped runtime is active.
- `Agent.restoreSessionFromTranscript` is now async and awaited by callers so user-scoped session restoration completes before the next request.

## [1.13.5] - 2026-07-03

### Added

- Added visible logout actions to the WebChat sidebar and Control Panel sidebar.

## [1.13.4] - 2026-07-03

### Added

- Made the first registered Web UI user an `admin`.
- Added admin-only user management APIs and Control Panel Users view for managing other Web accounts.

## [1.13.3] - 2026-07-03

### Added

- Added SQLite-backed Web UI registration/login protection for WebChat, Control Panel, and WebSocket connections.
- Scoped WebChat sessions and Weixin QR login/channel activation to the authenticated web user.

## [1.13.2] - 2026-07-03

### Changed

- Replaced the inline dog mascot SVG with an AI-designed Vex mascot image in the WebChat and control-panel UI.
- Copied WebChat image assets into `dist/` during builds so packaged releases can serve them.

## [1.13.1] - 2026-07-03

### Fixed

- Hid Personal WeChat sessions from the WebChat and control-panel session lists.
- Synced package lockfile metadata with the package version.

## [1.13.0] - 2026-07-03

### Added

- Added distribution hygiene and versioning support files.
- Added release gates for npm provenance publishing and GHCR image publishing.
- Added npm-first install docs, GHCR deployment docs, and maintainer release runbook.
- Added the weather tool and built-in Persona, ShareLink, and Skill Learner extensions.
- Added Persona background profile extraction from recent chat history.
- Added control-panel live backend log streaming.
- Added runtime config-path tracking for safer control-panel config writes.
- Added JSONL-backed session recovery and session de-duplication.

### Changed

- Overhauled control-panel interactions and UI behavior.
- Colorized server console logging by level while keeping daily log files as JSON.
- Started the web server before WeChat QR login so the control panel is available during login.
- Removed Persona group-chat ignore and admin-id gating.

### Fixed

- Fixed out-of-band `llmComplete` API-key handling.
- Fixed session classification and duplicate recovered sessions.
- Aborted terminal WeChat QR login when another login flow succeeds first.

## [1.12.0] - 2026-06-25

### Changed

- Seeded the Vex changelog from the current npm package version.
