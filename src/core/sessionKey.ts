/**
 * Session keys name a conversation: `wechat`, `device`, `web:<id>` for a WebChat conversation and
 * `run:<id>` for a temporary background run. Scheduled tasks store a target instead, where a WebChat
 * conversation is its bare id. Every key is built and parsed here.
 */
export const WECHAT_SESSION_KEY = "wechat";
export const DEVICE_SESSION_KEY = "device";
const WEB_PREFIX = "web:";
const RUN_PREFIX = "run:";

export function webSessionKey(id: string): string {
  return `${WEB_PREFIX}${id}`;
}

/** The WebChat conversation id of a key, or undefined for any other session. */
export function webSessionId(key: string): string | undefined {
  return key.startsWith(WEB_PREFIX) ? key.slice(WEB_PREFIX.length) : undefined;
}

export function runSessionKey(id: string): string {
  return `${RUN_PREFIX}${id}`;
}

/** The session a scheduled task's target delivers to; a bare id is a WebChat conversation. */
export function scheduleTargetKey(target: string): string {
  if (target === WECHAT_SESSION_KEY || target === DEVICE_SESSION_KEY || webSessionId(target) !== undefined) return target;
  return webSessionKey(target);
}

/** Where a schedule created in a conversation delivers by default: that conversation, or WeChat. */
export function scheduleTargetOf(key: string): string {
  if (key === DEVICE_SESSION_KEY) return DEVICE_SESSION_KEY;
  return webSessionId(key) ?? WECHAT_SESSION_KEY;
}
