# Browser Module

Playwright headless browser automation. Multi-profile Chrome sessions with persistent user data. Drives the `browser` built-in tool.

## STRUCTURE

```
browser/
├── types.ts            # BrowserProfile, BrowserConfig, BrowserAction (11 variants), SnapshotResult, etc.
├── service.ts          # BrowserService: lifecycle orchestration, action dispatch, getBrowserService() singleton
├── session.ts          # Session state, launch/stop, page event observation, ref locator resolution, ARIA parsing
├── screenshot.ts       # Screenshot capture (element/fullpage/labeled), sharp compression, page snapshots
├── profiles.ts         # ProfileManager: create/list/delete/setDefault, atomic persistence, CDP port allocation
└── index.ts            # Barrel
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Launch a browser | `session.ts:startSession()` | `launchPersistentContext` with per-profile user data dir |
| Take a screenshot | `screenshot.ts:takeScreenshot()` | Returns `ScreenshotResult` (Buffer, not base64) |
| Get page snapshot | `screenshot.ts:getPageSnapshot()` | `ariaSnapshot()` when available; falls back to DOM scanning |
| Execute browser action | `service.ts:executeAction()` | Switch on `action.kind`, resolves refs to locators |
| Manage profiles | `profiles.ts:ProfileManager` | Profiles persisted as JSON5 at `~/.vex/browser/profiles.json` |
| Resolve an element ref | `session.ts:getRefLocator()` | Ref ← ARIA snapshot mapping, with CSS selector fallback |
| Create default service | `service.ts:getBrowserService()` | Singleton, lazily initialized on first call |
| Compress large screenshots | `screenshot.ts:normalizeScreenshot()` | Quality/size gradient via optional `sharp`; degrades gracefully |

## BROWSER ACTIONS

11 discriminated union variants (`types.ts:BrowserAction`):

`click` `type` `press` `hover` `scroll` `drag` `select` `fill` `wait` `evaluate` `close`

Each action resolves `ref` strings against the session ref map (populated by snapshot). `wait` supports 7 conditions: `selector`, `text`, `textGone`, `timeout`, `load`, `network`, `url`. `fill` takes an array of `{ref, type, value}` for batching form fills.

## REQUIREMENTS

- `npx playwright install chromium` must be run before first use.
- `sharp` (optional) enables screenshot compression; silently falls back to raw PNG otherwise.
- Chrome user data directories live at `~/.vex/browser/profiles/<name>/`.
- CDP ports allocated from 19800–19899 range.
