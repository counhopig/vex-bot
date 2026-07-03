# Multi-User Architecture Plan

## Status

Implementation in progress for replacing the current mostly global backend model with a real multi-user backend.

Implemented so far:

- Authenticated Web users resolve chat and restore operations through a per-user runtime manager.
- Authenticated user runtimes get per-user Agent and MemoryManager instances.
- User-owned agent, memory, persona, extension, weather, and session preferences persist in SQLite under the owning Web user.
- Per-user AgentRuntime session directories and long-term memory directories are scoped under `users/{userId}`.
- Multi-user mode no longer starts the process-wide Weixin channel; `webAuth.enabled: false` preserves the legacy channel path.
- User-scoped Weixin inbound messages dispatch to the owning user's agent.
- Memory tools are bound to the manager used when the tool set is created, avoiding process-wide memory-manager takeover.
- Persona profile and memory keys include the owning Web user id for user-scoped Weixin messages.
- Session reset preserves the authenticated WebChat owner namespace.

Current problem: Web login users exist, but large parts of the backend still use one process-wide `VexConfig`, one process-wide `Agent`, and historically one process-wide Weixin channel/config surface. That makes user isolation fragile and can make two Web users appear to manage or share the same Weixin connection.

This plan is intentionally boundary-driven. Each phase includes explicit detection checks so we can prove whether a feature is still using global state where it should use user-scoped state.

## Goals

- Support multiple Web users on the same Vex server.
- Each user can connect and manage their own Weixin account.
- Each user gets isolated WebChat sessions, Weixin sessions, memory, persona state, and runtime agent state.
- Admin users can manage other Web accounts without implicitly sharing or taking over their Weixin connection.
- Preserve a single-user compatibility mode for existing deployments.
- Migrate existing `config.local.yaml` data safely.

## Non-Goals

- Do not add multi-tenant billing or quota management in this pass.
- Do not add OAuth or third-party identity providers in this pass.
- Do not implement admin impersonation unless explicitly requested later.
- Do not rewrite the inline Web UI into a frontend build system.
- Do not move all config into the database at once unless it is required for user isolation.

## Current Architecture Risks

| Area | Current Shape | Risk |
|---|---|---|
| Config | One global `VexConfig` loaded from YAML | User pages can display or save global channel/provider state |
| Agent | One `Agent` instance in `Gateway` | Runtime/session/memory state can bleed across users unless every key is perfectly scoped |
| Weixin | Global channel support plus user-scoped additions | A global Weixin connection can coexist with user channels and confuse routing/status |
| Control Panel | One config surface | Users see global Weixin status instead of their own account |
| Sessions | Shared session store, partially key-prefixed | Access checks must be consistent for all operations |
| Memory/persona | Configurable directories and singleton services | User A's preferences/facts can be mixed with User B's |
| Admin | Role exists, but account management is newly added | Needs strict permission checks and audit-friendly behavior |

## Target Model

### Global System State

Global YAML remains for system-level settings:

- Server host/port.
- Logging.
- Plugin loading rules.
- Global provider presets and optionally shared provider credentials.
- Default values for new users.
- Single-user compatibility mode.

Global YAML must not store per-user Weixin tokens in multi-user mode.

### User State

SQLite stores user-owned state:

- Login identity and role.
- Web login sessions.
- Per-user Weixin account/token.
- Per-user runtime settings.
- Per-user session ownership.
- Per-user memory/persona storage pointers or data.

### Runtime State

Introduce `UserRuntimeManager`:

- Owns one runtime per user.
- Lazily creates `UserRuntime` on demand.
- Restores user Weixin channels from DB on startup.
- Shuts down per-user channels cleanly.

`UserRuntime` contains:

- User id.
- User effective config.
- User `Agent`.
- Optional user `WeixinChannel`.
- User memory manager.
- User session namespace.

## Boundary Detection Rules

These checks should be used before and after every implementation phase.

### Config Boundary Checks

Detection command:

```bash
rg -n "config\\.channels\\.weixin|channels\\.weixin|config\\.agent|config\\.memory|config\\.persona" src
```

Allowed:

- `src/config/**` for schema/loading.
- Admin/system config handlers.
- User effective config builder.
- Migration code.

Suspicious:

- WebSocket handlers using global `this.config.channels.weixin` to report current user's login status.
- Gateway message processing using global config where user runtime should be used.
- Control Panel user pages saving global channel state.

Pass condition:

- User-facing `config.get/save` paths do not expose global Weixin token/account state.
- User-facing Weixin status comes from `user_weixin_accounts`.
- Admin-only system config path is clearly separated.

### Weixin Boundary Checks

Detection command:

```bash
rg -n "createWeixinChannel|registerChannel\\(|getChannel\\(\"weixin\"|replyToContext\\(context" src
```

Allowed:

- User runtime channel creation.
- Single-user compatibility mode.
- Tests.

Suspicious:

- `Gateway` creates a global Weixin channel while `webAuth.enabled !== false`.
- Replies route through `getChannel("weixin")` for user-owned inbound Weixin messages.
- QR status confirmation persists token to global YAML.

Pass condition:

- In multi-user mode, no process-wide Weixin channel is registered as the default handler.
- Each Weixin inbound message carries a verified `userId`.
- Replies go through that user's `WeixinChannel`.
- QR login for a Web user writes only to that user's DB row.

### Agent Boundary Checks

Detection command:

```bash
rg -n "createAgent\\(|this\\.agent|agent\\.processMessage|processMessageStream|restoreSessionFromTranscript" src
```

Allowed:

- `UserRuntimeManager` / `UserRuntime`.
- Single-user compatibility adapter.

Suspicious:

- A single `Gateway.agent` processes all Web and Weixin users in multi-user mode.
- WebSocket chat sends directly to a process-wide agent.

Pass condition:

- WebChat user A and user B use different `Agent` instances or a shared agent with provable per-user runtime/session isolation.
- Weixin user A messages go to A runtime only.

### Session Boundary Checks

Detection command:

```bash
rg -n "sessionKey|getOrCreate\\(|sessions\\.list|sessions\\.history|sessions\\.delete|sessions\\.restore" src/web src/sessions src/agents
```

Allowed session key formats:

- WebChat: `webchat:{userId}:{clientId}`.
- Weixin: `weixin:{userId}:{weixinPeerId}` or equivalent structured fields in DB.

Pass condition:

- Every session operation receives the authenticated `userId`.
- Session list/history/delete/restore cannot access another user's session.
- Tests include cross-user denial for every session operation.

### Memory And Persona Boundary Checks

Detection command:

```bash
rg -n "createMemoryManager|MemoryManager|persona|profile|user:" src
```

Suspicious:

- One memory directory shared for all users without a user namespace.
- Persona profile keys based only on `channelId:senderId`.

Pass condition:

- Memory data is stored under a per-user namespace or directory.
- Persona profile keys include Vex Web user id.
- Weixin contacts with the same sender id under different Vex users cannot collide.

### Admin Boundary Checks

Detection command:

```bash
rg -n "/api/admin|role|admin|deleteWebUser|updateWebUserRole|listWebUsers" src tests
```

Pass condition:

- Non-admin users cannot list, modify, or delete other users.
- Admin cannot delete or demote self.
- Admin actions do not expose tokens by default.
- Admin can see user connection status without receiving secrets.

### Secret Boundary Checks

Detection command:

```bash
rg -n "token|apiKey|password|passwordHash|bilibiliCookie|sessdata" src/web src/gateway src/config
```

Pass condition:

- API responses expose booleans like `hasToken`, not token values.
- Logs never include Weixin token, API keys, password hashes, or cookies.
- Admin user listing does not include secrets.

## Proposed Database Schema

### `users`

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK(role IN ('admin', 'user')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled')),
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### `user_sessions`

```sql
CREATE TABLE user_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
```

### `user_weixin_accounts`

```sql
CREATE TABLE user_weixin_accounts (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  account_id TEXT NOT NULL,
  base_url TEXT,
  ilink_user_id TEXT,
  bot_type TEXT,
  cdn_base_url TEXT,
  api_timeout_ms INTEGER,
  long_poll_timeout_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'connected',
  updated_at INTEGER NOT NULL
);
```

### `user_agent_settings`

```sql
CREATE TABLE user_agent_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  default_provider TEXT,
  default_model TEXT,
  temperature REAL,
  max_tokens INTEGER,
  system_prompt TEXT,
  memory_enabled INTEGER,
  persona_enabled INTEGER,
  updated_at INTEGER NOT NULL
);
```

### `user_runtime_state`

Optional table for persisted runtime metadata:

```sql
CREATE TABLE user_runtime_state (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);
```

## Config Model

### `SystemConfig`

Derived from `config.local.yaml`.

Contains:

- `server`
- `logging`
- global provider definitions
- plugin settings
- global feature flags
- default user settings
- `webAuth`
- `singleUserMode`

Does not contain:

- User Weixin token in multi-user mode.
- User-specific memory/persona/session state.

### `UserEffectiveConfig`

Built from:

1. System defaults from YAML.
2. User settings from SQLite.
3. User Weixin account from SQLite.

This is the config passed into user runtime construction.

## Runtime Design

### `UserRuntimeManager`

Responsibilities:

- `getOrCreate(userId): Promise<UserRuntime>`
- `activateWeixin(userId, account): Promise<void>`
- `deactivateUser(userId): Promise<void>`
- `restoreAllWeixinChannels(): Promise<void>`
- `shutdown(): Promise<void>`

It owns:

- `Map<string, UserRuntime>`
- Runtime lifecycle and cleanup.

### `UserRuntime`

Responsibilities:

- Process WebChat messages for one user.
- Process Weixin inbound messages for one user.
- Route replies through the user's channel.
- Own memory/session/persona scope.

Pseudo-shape:

```ts
interface UserRuntime {
  userId: string;
  agent: Agent;
  memoryManager?: MemoryManager;
  weixinChannel?: WeixinChannel;
  processWebChatMessage(input): Promise<Response>;
  processWeixinMessage(context): Promise<void>;
  shutdown(): Promise<void>;
}
```

## API Design

### Auth APIs

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`

### User APIs

- `GET /api/me/weixin`
- `POST /api/me/weixin/qr`
- `POST /api/me/weixin/qr/status`
- `DELETE /api/me/weixin`
- `GET /api/me/settings`
- `PATCH /api/me/settings`

### Admin APIs

- `GET /api/admin/users`
- `PATCH /api/admin/users/:id`
- `DELETE /api/admin/users/:id`
- `GET /api/admin/users/:id/status`
- `POST /api/admin/users/:id/disable`
- `POST /api/admin/users/:id/enable`

Admin APIs must not return token values unless a future explicit secret export feature is added.

### WebSocket Methods

Keep chat/session operations user-bound:

- `chat.send`
- `chat.cancel`
- `chat.clear`
- `sessions.list`
- `sessions.history`
- `sessions.delete`
- `sessions.restore`

Replace ambiguous config/channel methods:

- Deprecate user-facing `config.get/save` for multi-user mode.
- Add `user.config.get/save`.
- Add `admin.systemConfig.get/save`.
- Move Weixin QR methods to `user.weixin.qr` and `user.weixin.qr.status`, or HTTP endpoints above.

## Migration Plan

### Migration Inputs

- Existing SQLite auth DB if present.
- Existing `config.local.yaml`.
- Existing session store.
- Existing memory/persona store.

### Migration Steps

1. Add DB migrations table.
2. Add user roles/status if missing.
3. If `config.channels.weixin.token` exists:
   - If there is exactly one admin user, migrate token to that admin's `user_weixin_accounts`.
   - If there are no users, leave YAML unchanged and print a warning.
   - If there are multiple admins, leave YAML unchanged and print an admin action warning.
4. In multi-user mode, stop using global YAML Weixin token after migration.
5. Preserve single-user mode behavior when `webAuth.enabled === false`.

### Rollback

- DB migrations must be additive for the first pass.
- Do not delete YAML token automatically.
- Mark migrated token as copied, not moved, until multi-user mode is verified.

## Implementation Phases

### Phase 0: Freeze Partial Patch

Goal: prevent accidental commits of half-fixes.

Tasks:

- Review uncommitted changes.
- Either revert or replace them as part of Phase 1.
- Add this plan document.

Exit criteria:

- Working tree contains only intentional phase changes.

### Phase 1: Storage And Auth Boundary

Tasks:

- Add DB migration runner.
- Normalize `web_users` into target `users` shape or document legacy table compatibility.
- Add user status.
- Add user Weixin account getters/setters.
- Add admin management tests.

Detection checks:

```bash
rg -n "token|passwordHash|password_hash" src/web src/gateway
```

Exit criteria:

- Auth APIs return no secrets.
- First user admin behavior is tested.
- Admin cannot delete/demote self.

### Phase 2: User Runtime Manager

Tasks:

- Add `UserRuntimeManager`.
- Move user-scoped `Agent` creation into runtime manager.
- Move user-scoped `WeixinChannel` creation into runtime manager.
- Gateway delegates WebChat and Weixin messages to the correct runtime.

Detection checks:

```bash
rg -n "private agent|this\\.agent|createAgent\\(" src/gateway src/web
rg -n "createWeixinChannel|registerChannel\\(" src/gateway src/web src/channels
```

Exit criteria:

- No global `Gateway.agent` handles multi-user traffic.
- No global Weixin channel starts when `webAuth.enabled !== false`.
- Two users can have two active Weixin channels in memory.

### Phase 3: Config Split

Tasks:

- Add `SystemConfig` vs `UserEffectiveConfig` types.
- Add `buildUserEffectiveConfig(userId)`.
- Replace user-facing `config.get/save`.
- Keep admin-only system config editor.

Detection checks:

```bash
rg -n "config\\.channels\\.weixin|config\\.agent|config\\.memory|config\\.persona" src/web src/gateway src/agents
```

Exit criteria:

- User pages show user Weixin status from DB.
- Admin system config page cannot overwrite a user's Weixin token.
- User settings save only affects that user.

### Phase 4: Sessions, Memory, Persona Isolation

Tasks:

- Ensure session keys include user id or store user id structurally.
- Scope memory directory by user id.
- Scope persona/profile keys by user id.
- Add cross-user access denial tests.

Detection checks:

```bash
rg -n "webchat:|weixin:|user:" src/sessions src/agents src/extensions src/memory
```

Exit criteria:

- User A cannot list/read/delete User B sessions.
- Same Weixin sender id under two Vex users produces separate memory/persona records.

### Phase 5: UI Redesign

Tasks:

- Control Panel:
  - My Weixin
  - My Settings
  - Admin Users
  - Admin System Settings
- WebChat:
  - User identity display.
  - Logout.
  - User-scoped sessions.

Detection checks:

```bash
rg -n "config.get|config.save|weixin.qr|weixin.qr.status" src/web/template-client.ts src/web/static.ts
```

Exit criteria:

- No ordinary user UI calls admin/system config endpoints.
- Users do not see another user's Weixin status.

### Phase 6: Migration And Compatibility

Tasks:

- Add migration logs and docs.
- Add `webAuth.enabled: false` single-user compatibility tests.
- Add startup warnings for ambiguous token migration.

Exit criteria:

- Existing single-user installs still boot.
- New multi-user installs do not create/use global Weixin token.

## Test Plan

### Unit Tests

- First registered user is admin.
- Later registered user is user.
- Admin can list/update/delete other users.
- Admin cannot delete or demote self.
- User Weixin login is stored per user.
- `getUserWeixinLogin(A) !== getUserWeixinLogin(B)`.

### Integration Tests

- Two users connect WebSocket simultaneously.
- User A QR login activates A runtime channel only.
- User B QR login activates B runtime channel only.
- User A `config/user settings` endpoint returns A data.
- User B endpoint returns B data.
- Admin user listing does not expose token values.

### Regression Tests

- `webAuth.enabled: false` still starts old single-user flow.
- `sessions.list` filters out Weixin sessions from WebChat UI.
- Build copies Web assets.
- Docker build can install native SQLite dependency.

## Operational Checks

Before release:

```bash
npm test -- --run
npm run lint
npm run build
npm run pack:dry-run
```

Manual checks:

1. Register first user, verify role admin.
2. Register second user, verify role user.
3. Login as user A, scan Weixin A.
4. Login as user B, scan Weixin B.
5. Send Weixin message to A account, verify A runtime responds.
6. Send Weixin message to B account, verify B runtime responds.
7. Login as B, verify B cannot see A status or sessions.
8. Login as admin, verify admin can see users but not tokens.

## Release Notes Template

- Added true multi-user runtime isolation.
- Split system config from user runtime config.
- Moved Weixin login state to per-user SQLite records in multi-user mode.
- Added admin user management while preventing cross-user token exposure.
- Preserved single-user compatibility with `webAuth.enabled: false`.

## Open Decisions

- Should user provider API keys be per-user, shared-global, or both?
- Should admin be able to disable a user's active Weixin channel without deleting the user?
- Should memory/persona data live in SQLite or per-user file directories?
- Should old global Weixin token migration be automatic or require an admin confirmation button?
- Should user deletion soft-delete first, with a later purge command?
