/**
 * logs.* WS method handlers — injected into WebChatChannel.handlers.
 *
 * Ported from the archive's WsServer.handleLogsSubscribe/handleLogsUnsubscribe.
 * The backend log stream is an operator/admin view: any authenticated user
 * must not be able to read it. Single-user mode (web auth disabled) has one
 * operator, so there's nothing to gate (canAccessBackendLogs).
 *
 * Subscription lifecycle: each client's LogStreamer subscription is tracked
 * per client id; `logs.unsubscribe` or a disconnect (via client.onDisconnect)
 * both detach it. The channel calls registered cleanups on close, so a
 * subscriber never leaks a polling loop after the socket drops.
 */

import { getChildLogger } from "../../utils/logger.js";
import type { LogStreamer, BackendLogEntry } from "./log-stream.js";
import type { WsClientView, WsMethodHandler } from "../../channels/webchat/WebChatChannel.js";
import { canAccessBackendLogs } from "../../channels/webchat/WebChatChannel.js";

const logger = getChildLogger("ws-log-stream");

export interface LogStreamHandlersOptions {
  logStreamer: LogStreamer;
  /** Whether web auth is enabled — gates the admin-only log view. */
  webAuthEnabled: boolean;
}

export function createLogStreamHandlers(options: LogStreamHandlersOptions): Record<string, WsMethodHandler> {
  const { logStreamer, webAuthEnabled } = options;
  const subscriptions = new Map<string, () => void>();

  function requireBackendLogAccess(client: WsClientView): void {
    if (!canAccessBackendLogs(webAuthEnabled, client.user?.role)) {
      throw new Error("Admin privileges required");
    }
  }

  return {
    "logs.subscribe"(client) {
      requireBackendLogAccess(client);

      if (!subscriptions.has(client.id)) {
        const unsubscribe = logStreamer.subscribe((entry: BackendLogEntry) => {
          client.sendEvent("log.entry", entry);
        });
        subscriptions.set(client.id, unsubscribe);
        // Detach on disconnect so the polling loop stops when the socket drops.
        client.onDisconnect(() => {
          unsubscribe();
          subscriptions.delete(client.id);
          logger.debug({ clientId: client.id }, "Log subscription cleaned up on disconnect");
        });
        logger.debug({ clientId: client.id }, "Log subscription registered");
      }

      return { entries: logStreamer.getBacklog() };
    },

    "logs.unsubscribe"(client) {
      requireBackendLogAccess(client);

      const unsubscribe = subscriptions.get(client.id);
      if (unsubscribe) {
        unsubscribe();
        subscriptions.delete(client.id);
        logger.debug({ clientId: client.id }, "Log subscription removed");
      }
      return { ok: true };
    },
  };
}
