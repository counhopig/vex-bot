import type { VexConfig } from "./schema.js";

const SECRET_ENV_NAME = /(?:key|token|secret|password|cookie|credential|auth|sessdata)/i;
const SECRET_QUERY_NAME = /(?:key|token|secret|password|cookie|auth|credential)/i;

/**
 * Every credential the configuration or environment can hand the runtime, so text sent to an
 * external evaluator can be redacted. Over-collecting is harmless; missing one leaks it.
 */
export function configuredSecrets(config: VexConfig, env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    ...Object.values(config.providers ?? {}).flatMap((provider) => provider.apiKey ? [provider.apiKey] : []),
    config.jev?.apiKey, env.TYPESAFE_API_KEY,
    config.links?.bilibili?.sessdata, env.BILIBILI_SESSDATA,
    config.web.token, config.webSearch?.apiKey, config.stt?.apiKey, ...urlCredentialValues(config.stt?.baseUrl),
    config.vault?.token, config.vault?.username, ...urlCredentialValues(config.vault?.url),
    ...Object.values(config.mcpServers ?? {}).flatMap((server) => "env" in server ? Object.values(server.env ?? {}) : "headers" in server ? Object.values(server.headers ?? {}) : []),
    ...Object.values(config.mcpServers ?? {}).flatMap((server) => urlCredentialValues("url" in server ? server.url : undefined)),
    ...Object.entries(env).filter(([name, value]) => SECRET_ENV_NAME.test(name) && typeof value === "string").map(([, value]) => value),
  ].filter((secret): secret is string => typeof secret === "string" && secret.length > 0);
}

function urlCredentialValues(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const url = new URL(value);
    const secrets = [url.username, url.password];
    for (const [key, item] of url.searchParams) if (SECRET_QUERY_NAME.test(key)) secrets.push(item);
    return secrets.filter(Boolean);
  } catch { return []; }
}
