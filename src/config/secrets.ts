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
    config.web.token, config.device?.token, config.webSearch?.apiKey, config.stt?.apiKey, ...urlCredentialValues(config.stt?.baseUrl),
    config.vault?.token, ...urlCredentialValues(config.vault?.url),
    ...Object.values(config.mcpServers ?? {}).flatMap((server) => secretNamed("env" in server ? server.env : "headers" in server ? server.headers : undefined)),
    ...Object.values(config.mcpServers ?? {}).flatMap((server) => urlCredentialValues("url" in server ? server.url : undefined)),
    ...Object.entries(env).filter(([name, value]) => SECRET_ENV_NAME.test(name) && typeof value === "string" && credentialLike(value)).map(([, value]) => value),
  ].filter((secret): secret is string => typeof secret === "string" && secret.length > 0);
}

/**
 * Environment variables are picked by name alone, which also matches settings such as
 * `MAX_THINKING_TOKENS=32000` or `FOO_KEYS_ENABLED=1`; redacting those values would rewrite every
 * matching digit or word in the request, including the URLs a link action must match.
 */
function credentialLike(value: string): boolean {
  return value.length >= 8 && !settingLike(value);
}

const settingLike = (value: string): boolean => /^\d+$/.test(value) || /^(?:true|false|yes|no|on|off)$/i.test(value);

/**
 * MCP server variables and headers also carry settings (`DEBUG: "1"`, `Accept: application/json`),
 * so only secret-named entries count; those were written for this server, so short values count too.
 */
function secretNamed(entries: Record<string, string> | undefined): string[] {
  return Object.entries(entries ?? {}).filter(([name, value]) => SECRET_ENV_NAME.test(name) && !settingLike(value)).map(([, value]) => value);
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

/**
 * Replaces known secrets, bearer tokens and key/token/cookie assignments in every string of `value`
 * before it leaves the process, for example to an external evaluator.
 */
export function redactSecrets<T>(value: T, secrets: string[]): T {
  return redact(value, secrets) as T;
}

function redact(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") {
    let output = value;
    for (const secret of secrets.filter(Boolean)) output = output.split(secret).join("[redacted]");
    return output.replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi, "$1[redacted]")
      .replace(/((?:api[_-]?key|token|cookie|sessdata)\s*[:=]\s*)[^\s,;"']+/gi, "$1[redacted]");
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, secrets)]));
  return value;
}
