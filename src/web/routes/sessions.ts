/**
 * sessions.* WS method handlers — injected into WebChatChannel.handlers.
 *
 * Ported from the archive's WsServer.handleSessions* methods. Each handler is
 * `(client, params) => payload` and returns the res payload; the channel
 * wraps the response frame. Session ownership is enforced by the
 * `webchat:{userId}:` key prefix — a client can only touch its own sessions.
 */

import { getChildLogger } from "../../utils/logger.js";
import type { FileSessionStore } from "../../sessions/store.js";
import type { WsClientView, WsMethodHandler } from "../../channels/webchat/WebChatChannel.js";
import { filterWebChatSessions } from "../../channels/webchat/WebChatChannel.js";

const logger = getChildLogger("ws-sessions");

export interface SessionHandlersOptions {
  sessionStore: FileSessionStore;
}

const WEBCHAT_SESSION_PREFIX = "webchat:";

/** A client's session namespace: `webchat:{userId}:` when authenticated,
 *  bare `webchat:` otherwise. */
function sessionOwnerPrefix(client: WsClientView): string {
  return client.user ? `${WEBCHAT_SESSION_PREFIX}${client.user.id}:` : WEBCHAT_SESSION_PREFIX;
}

/** Reject access to a session the client does not own. */
function assertSessionAccess(client: WsClientView, sessionKey: string): void {
  if (!sessionKey.startsWith(sessionOwnerPrefix(client))) {
    throw new Error("Session not found");
  }
}

export function createSessionHandlers(options: SessionHandlersOptions): Record<string, WsMethodHandler> {
  const { sessionStore } = options;

  return {
    async "sessions.list"(client, params) {
      const p = (params ?? {}) as { limit?: number; activeMinutes?: number; search?: string };
      const sessions = await sessionStore.list({
        activeMinutes: p.activeMinutes,
        search: p.search,
      });
      return { sessions: filterWebChatSessions(sessions, p.limit, client.user?.id) };
    },

    async "sessions.history"(client, params) {
      const p = params as { sessionKey: string };
      assertSessionAccess(client, p.sessionKey);
      const session = await sessionStore.get(p.sessionKey);
      if (!session) {
        throw new Error(`Session not found: ${p.sessionKey}`);
      }
      const messages = await sessionStore.loadTranscript(session.sessionId);
      return { sessionKey: p.sessionKey, sessionId: session.sessionId, messages };
    },

    async "sessions.delete"(client, params) {
      const p = params as { sessionKey: string };
      assertSessionAccess(client, p.sessionKey);
      await sessionStore.delete(p.sessionKey);
      logger.debug({ sessionKey: p.sessionKey }, "Session deleted");
      return { success: true };
    },

    async "sessions.reset"(client, params) {
      const p = params as { sessionKey: string };
      assertSessionAccess(client, p.sessionKey);
      const session = await sessionStore.reset(p.sessionKey);
      return { success: true, sessionKey: session.sessionKey, sessionId: session.sessionId };
    },

    async "sessions.restore"(client, params) {
      const p = params as { sessionKey: string };
      assertSessionAccess(client, p.sessionKey);
      const session = await sessionStore.get(p.sessionKey);
      if (!session) {
        throw new Error(`Session not found: ${p.sessionKey}`);
      }

      // Rebinding the client to this session key is all the agent needs: the
      // runtime derives its session key from the same key and reloads that
      // session's persisted transcript on the next turn. The UI transcript is
      // returned below for display; there is no separate replay step.
      client.sessionKey = session.sessionKey;
      client.sessionId = session.sessionId;

      const messages = await sessionStore.loadTranscript(session.sessionId);
      return { sessionKey: session.sessionKey, sessionId: session.sessionId, messages };
    },

    async "chat.clear"(client) {
      // Archive handleChatClear: reset the client's CURRENT session and rebind
      // it to the fresh one. Unlike sessions.reset (which takes a sessionKey),
      // this operates on the client's bound session — the "new chat" button.
      if (!client.sessionKey) {
        throw new Error("No active session");
      }
      const session = await sessionStore.reset(client.sessionKey);
      client.sessionKey = session.sessionKey;
      client.sessionId = session.sessionId;
      logger.debug(
        { clientId: client.id, newSessionKey: session.sessionKey },
        "Chat cleared, new session created",
      );
      return { success: true, sessionKey: session.sessionKey, sessionId: session.sessionId };
    },
  };
}
