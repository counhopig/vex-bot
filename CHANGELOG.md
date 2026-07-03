# Changelog

All notable changes to this project will be documented in this file.

This project follows semantic versioning for npm package releases.

## [Unreleased]
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
