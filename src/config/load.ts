import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Value } from "typebox/value";
import { parse } from "yaml";
import { expandHome, type VexPaths } from "../paths.js";
import { writeFileAtomic } from "../store/atomic.js";
import { ConfigSchema, DEFAULT_WECHAT_BASE_URL, type VexConfig } from "./schema.js";

export class ConfigError extends Error {}

export function parseConfig(text: string, paths: VexPaths): VexConfig {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    throw new ConfigError(`config.yaml is not valid YAML: ${(err as Error).message}`);
  }
  if (!Value.Check(ConfigSchema, raw)) {
    const details = [...Value.Errors(ConfigSchema, raw)]
      .slice(0, 5)
      .map((e) => `${e.instancePath || "/"} ${e.message}`)
      .join("；");
    throw new ConfigError(`config.yaml failed validation: ${details}`);
  }
  return {
    model: raw.model,
    backgroundModel: raw.backgroundModel ?? raw.model,
    providers: raw.providers ?? {},
    web: {
      host: raw.web?.host ?? "127.0.0.1",
      port: raw.web?.port ?? 7860,
      token: raw.web?.token || undefined,
    },
    workspace: raw.workspace ? resolve(paths.home, expandHome(raw.workspace)) : paths.defaultWorkspace,
    toolPolicy: raw.tools?.policy ?? {},
    bashEnvPassthrough: raw.bashEnvPassthrough ?? [],
    compaction: { threshold: raw.compaction?.threshold ?? 0.7 },
    ...(raw.memory ? { memory: raw.memory } : {}),
    ...(raw.heartbeat ? { heartbeat: raw.heartbeat } : {}),
    ...(raw.persona ? { persona: raw.persona } : {}),
    ...(raw.webSearch ? { webSearch: raw.webSearch } : {}),
    ...(raw.stt ? { stt: raw.stt } : {}),
    ...(raw.mcpServers ? { mcpServers: raw.mcpServers } : {}),
    wechat: {
      enabled: raw.wechat?.enabled ?? true,
      ownerId: raw.wechat?.ownerId,
      baseUrl: raw.wechat?.baseUrl ?? DEFAULT_WECHAT_BASE_URL,
    },
  };
}

export async function loadConfig(paths: VexPaths): Promise<{ config: VexConfig; text: string }> {
  let text: string;
  try {
    text = await readFile(paths.config, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConfigError(`Config file not found: ${paths.config}. Run vex onboard first`);
    }
    throw err;
  }
  const config = parseConfig(text, paths);
  const host = process.env.VEX_WEB_HOST?.trim();
  const token = process.env.VEX_WEB_TOKEN?.trim();
  if (host) config.web.host = host;
  if (token) config.web.token = token;
  return { config, text };
}

export async function saveConfigText(paths: VexPaths, text: string): Promise<void> {
  parseConfig(text, paths);
  await writeFileAtomic(paths.config, text, 0o600, 0o700);
}
