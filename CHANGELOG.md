# Changelog

All notable changes to this project will be documented in this file.

This project follows semantic versioning for npm package releases.

## [Unreleased]

### BREAKING

- **`server.host` now defaults to `127.0.0.1` (was `0.0.0.0`).** A fresh install is no longer reachable from other machines by default. If you relied on the old default for remote access, set `server.host: 0.0.0.0` in your config or pass `--host 0.0.0.0` to `vex start`. The Docker images already pass `--host 0.0.0.0` (the container is isolated; the published port mapping controls real exposure), so Docker deployments are unaffected.
- **Self-service registration (`POST /api/auth/register`) is now closed by default.** The first account can always register (it bootstraps the admin); after that, accounts must be created by an admin via the new `POST /api/admin/users` endpoint, unless `webAuth.allowRegistration: true` is set.
- **The bash tool no longer inherits the full process environment.** Spawned commands see only a base allowlist (PATH, HOME, locale, proxy variables, ...) so provider API keys in the process environment cannot be read by a single `bash` call. Extra variables must be opted in via `agent.bashEnvPassthrough: [..]`. The bypassable `blockedCommands` regex denylist was removed along with its option.

### Fixed

- Non-admin requests to `PATCH/DELETE /api/admin/users/:id` now return 403 as intended; the error-message string matching used to map them to 400.
- A malformed percent-encoding in any cookie (e.g. a third-party tracking cookie) crashed cookie parsing with a `URIError` and turned every authenticated request into a 500. Values that fail to decode are now kept raw instead.
- A corrupt `settings_json` row no longer throws on every load — which failed the user's runtime construction and locked them out of chat entirely. It now logs a warning and falls back to empty settings; the next save overwrites the bad row.
- Changing the server port in the control panel now correctly reports "restart required"; the check compared the new port against the already-updated live config, so it was always false.
- The control panel showed `0.0.0.0` as the default bind host when none was set, contradicting the actual `127.0.0.1` default; it now shows `127.0.0.1`.
- A per-user runtime rebuild could overlap the previous runtime's teardown on the same scoped directory (idle eviction disposes fire-and-forget, then rebuilds immediately). The rebuild now waits for the prior teardown to complete before touching the directory.
- The memory index is now written atomically (temp file + rename) instead of overwriting `index.json` in place, so a crash or overlapping write can't leave a truncated index that fails to load.
- Idle per-user runtimes are now reclaimed by a background timer, not only lazily on the next request, so a quiet multi-user instance releases their SQLite handles and memory past the idle TTL.

### Security

- The `logs.subscribe` / `logs.unsubscribe` WebSocket methods now require an admin (when web auth is enabled). The backend log stream carries every user's chat previews, session keys, and errors; previously any authenticated user could subscribe and read all of it. Single-user mode (web auth disabled) is unaffected.
- Login no longer leaks which usernames exist through response timing: unknown-username attempts now run the same scrypt verification (against a dummy hash) as wrong-password attempts.
- `POST /api/auth/login` is rate-limited per IP+username (10 failures per 5 minutes, in memory); over the limit it returns 429. A successful login resets the counter.
- Password hashing switched from synchronous to asynchronous scrypt, so unauthenticated login/register requests can no longer stall the event loop.
- The config `rawYaml` patch is now schema-validated (against `VexConfigSchema`) before it is written or applied to the live config. Previously it bypassed validation entirely, so a malformed admin patch could corrupt the persisted config and crash the running instance.

### Changed

- User-management errors (`requireAdmin`, `updateWebUserRole`, `deleteWebUser`) now carry their HTTP status (`HttpError`) instead of being guessed from message text. `User not found` on `PATCH/DELETE /api/admin/users/:id` now returns 404 (previously 403 via the fallback), and unexpected server errors on admin routes return 500.
- `createWebUser` validation and credential parsing are typed the same way: a duplicate username on `POST /api/auth/register` / `POST /api/admin/users` now returns 409 (was 400), unexpected server errors on those routes return 500 (were 400), and the SQLite UNIQUE violation is detected via the structured error code instead of message text. Passwords are now capped at 128 characters (minimum stays 8).
- `loginWebUser` failures are typed as `HttpError(401)`; the login route no longer reports genuine server errors as 401 (they return 500). `createWebUser` and `loginWebUser` are now async (they await the scrypt hash).
- `saveUserConfigSettings` and `saveUserWeixinLogin` throw `HttpError(404, "User not found")` directly instead of wrapping every failure into `Failed to save user settings: ...` / losing the error type; unexpected errors propagate unwrapped.
- WebSocket error responses now carry a numeric `status` when the failure is a typed `HttpError`, so the client can distinguish 401/403/404. The `chat.send` message is capped at 100k characters, and its unused `sessionKey` parameter (the target session is always the client's own) was removed.

### Added

- `agent.temperature` and `agent.maxTokens` are now actually applied to LLM calls made through the agent runtime; previously they were accepted by the config schema but silently ignored.
- `--host` CLI flag for `vex start` to override the bind address.
- `weixin.unbind` WebSocket method: unbinds the current user's Weixin login, deletes the stored token, and shuts down their running Weixin channel immediately. Previously a binding could only be removed by deleting the account.

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
