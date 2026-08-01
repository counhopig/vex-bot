/**
 * web/ module — barrel.
 *
 * Re-exports the server bootstrap, the static asset service, the control-
 * panel route handlers, and the WebChat types. The legacy module-level
 * singletons from the archive (getSessionStore, getRequestUser, etc.) are
 * intentionally NOT re-exported — every consumer instantiates its own
 * WebAuthStore / FileSessionStore / WebServer with explicit dependencies
 * (principle #5).
 */

export { WebServer, resolveBindHost, MessageDeduplicator, runShutdownSteps, createKeyedSerializer } from "./server.js";
export type { WebServerOptions } from "./server.js";
export { handleStaticRequest } from "./static/index.js";
export type { StaticServerOptions } from "./static/index.js";
export type {
  ConfigInfo,
  ConfigSaveParams,
  ConfigValidateResult,
  SystemStatus,
  WsFrame,
  WsRequestFrame,
  WsResponseFrame,
  WsEventFrame,
  ChatDeltaEvent,
} from "./types.js";
export { WeixinCredentialStore } from "./WeixinCredentialStore.js";
export type { StoredUserWeixinLogin, WeixinLoginInput } from "./WeixinCredentialStore.js";
