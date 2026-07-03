# Changelog

All notable changes to this project will be documented in this file.

This project follows semantic versioning for npm package releases.

## [Unreleased]

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
