/**
 * Control-panel WS method handlers — status.get / session.info / config.*
 *
 * Ported from the archive's WsServer.getSystemStatus/getSessionInfo/
 * getConfigForClient/saveConfigForClient. Injected into WebChatChannel.handlers
 * by the web/server.ts bootstrap. The config read/write primitives live in
 * ./config.ts (pure functions); this module adds the per-client resolution
 * (authenticated user vs single-user mode) the archive did inline.
 *
 * Security behaviors preserved from the archive:
 *  - config.get returns the SYSTEM config for unauthenticated/single-user
 *    clients, and the user-merged config for authenticated ones.
 *  - config.save in multi-user mode only persists USER-scoped settings unless
 *    the client is an admin; system-level params (providers/channels/server/
 *    logging/skills/rawYaml) are stripped for non-admins.
 *  - Per-user config changes reset the user's runtime (onResetUser), so the
 *    new settings take effect immediately.
 */

import { getChildLogger } from "../../utils/logger.js";
import {
  getConfigInfo,
  getUserConfigInfo,
  validateConfig,
  saveConfig,
  extractUserConfigSettings,
  extractSystemConfigParams,
  type SystemConfig,
} from "./config.js";
import type {
  ConfigInfo,
  ConfigSaveParams,
  ConfigValidateResult,
  SystemStatus,
} from "../types.js";
import type { WsClientView, WsMethodHandler } from "../../channels/webchat/WebChatChannel.js";
import type { WebAuthStore, UserConfigSettings, PublicWebUser } from "./auth.js";

const logger = getChildLogger("ws-admin");

export interface AdminHandlersOptions {
  /** Application version reported by status.get. */
  version: string;
  /** Resolve the current system config the control panel reads/edits. */
  getConfig: () => SystemConfig;
  /** Path of the runtime config file (for config.save). */
  configPath: string;
  /** Authentication — isEnabled + per-user settings. */
  auth: WebAuthStore;
  /** Live provider list for status.get. */
  getProviders: () => Array<{ id: string; name: string; available: boolean }>;
  /** Live channel list for status.get. */
  getChannels: () => Array<{ id: string; name: string; connected: boolean }>;
  /** Server uptime in ms for status.get. */
  getUptimeMs: () => number;
  /** Connected WebChat client count for status.get. */
  getClientCount: () => number;
  /** Per-user WeChat channel status for status.get (optional). */
  getUserWeixinStatus?: (userId: string) => { configured: boolean; connected: boolean; accountId?: string };
  /** Reset a user's runtime after a per-user config save. */
  onResetUser?: (userId: string) => Promise<void>;
  /** Session info provider for session.info (the new Agent exposes no
   *  getSessionInfo; the bootstrap may supply a store-backed implementation). */
  getSessionInfo?: (client: WsClientView) => Promise<unknown> | unknown;
}

export function createAdminHandlers(options: AdminHandlersOptions): Record<string, WsMethodHandler> {
  const {
    version,
    getConfig,
    configPath,
    auth,
    getProviders,
    getChannels,
    getUptimeMs,
    getClientCount,
    getUserWeixinStatus,
    onResetUser,
    getSessionInfo,
  } = options;

  /** Archive getSystemStatus: providers/channels with the "configured => connected"
   *  simplification, plus the per-user WeChat channel when configured. */
  function systemStatus(client: WsClientView): SystemStatus {
    const agent = getConfig().agent ?? {};
    const providers = getProviders();
    const channels: SystemStatus["channels"] = getChannels().map((c) => ({
      id: c.id,
      name: c.name,
      connected: c.connected,
    }));
    const userWeixin = client.user ? getUserWeixinStatus?.(client.user.id) : undefined;
    if (userWeixin?.configured && !channels.some((channel) => channel.id === "weixin")) {
      channels.push({
        id: "weixin",
        name: "Personal WeChat",
        connected: userWeixin.connected,
      });
    }
    return {
      version,
      defaultProvider: typeof agent.defaultProvider === "string" ? agent.defaultProvider : "",
      defaultModel: typeof agent.defaultModel === "string" ? agent.defaultModel : "",
      uptime: getUptimeMs(),
      providers,
      channels,
      sessions: getClientCount(),
    };
  }

  /** Archive getConfigForClient: system config unless the client is an
   *  authenticated user in multi-user mode, in which case merge their settings. */
  function configForClient(client: WsClientView): ConfigInfo {
    if (!client.user || !auth.isEnabled) {
      return getConfigInfo(getConfig());
    }
    return getUserConfigInfo(
      getConfig(),
      auth.getUserConfigSettings(client.user.id),
      client.user,
    );
  }

  /** Archive saveConfigForClient: per-user settings for authenticated users,
   *  system config only for admins; single-user mode saves system config. */
  async function saveConfigForClient(
    client: WsClientView,
    params: ConfigSaveParams,
  ): Promise<{ success: boolean; message: string; requiresRestart?: boolean }> {
    if (!client.user || !auth.isEnabled) {
      return saveConfig(configPath, getConfig(), params);
    }
    const validation = validateConfig(params);
    if (!validation.valid) {
      return {
        success: false,
        message: "Config validation failed: " + validation.errors.join("; "),
      };
    }
    auth.saveUserConfigSettings(client.user.id, extractUserConfigSettings(params));
    await onResetUser?.(client.user.id);
    const systemParams = client.user.role === "admin" ? extractSystemConfigParams(params) : {};
    if (Object.keys(systemParams).length === 0) {
      return { success: true, message: "User settings saved" };
    }
    const systemResult = saveConfig(configPath, getConfig(), systemParams);
    return systemResult.success
      ? { ...systemResult, message: "User settings and system config saved" }
      : systemResult;
  }

  return {
    "status.get"(client) {
      return systemStatus(client);
    },

    async "session.info"(client) {
      const info = getSessionInfo ? await getSessionInfo(client) : undefined;
      return {
        sessionKey: client.sessionKey,
        sessionId: client.sessionId,
        ...(info as Record<string, unknown> | undefined),
      };
    },

    "config.get"(client) {
      return configForClient(client);
    },

    "config.validate"(client, params) {
      return validateConfig((params ?? {}) as ConfigSaveParams) as ConfigValidateResult;
    },

    async "config.save"(client, params) {
      return saveConfigForClient(client, (params ?? {}) as ConfigSaveParams);
    },
  };
}
