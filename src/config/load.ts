import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Value } from "typebox/value";
import { parse } from "yaml";
import { expandHome, type VexPaths } from "../paths.js";
import { writeFileAtomic } from "../store/atomic.js";
import { ConfigSchema, type VexConfig } from "./schema.js";

export class ConfigError extends Error {}

export function parseConfig(text: string, paths: VexPaths): VexConfig {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    throw new ConfigError(`config.yaml 不是合法的 YAML：${(err as Error).message}`);
  }
  if (!Value.Check(ConfigSchema, raw)) {
    const details = [...Value.Errors(ConfigSchema, raw)]
      .slice(0, 5)
      .map((e) => `${e.instancePath || "/"} ${e.message}`)
      .join("；");
    throw new ConfigError(`config.yaml 校验失败：${details}`);
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
  };
}

export async function loadConfig(paths: VexPaths): Promise<{ config: VexConfig; text: string }> {
  let text: string;
  try {
    text = await readFile(paths.config, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConfigError(`找不到配置文件 ${paths.config}，请先运行 vex onboard`);
    }
    throw err;
  }
  return { config: parseConfig(text, paths), text };
}

export async function saveConfigText(paths: VexPaths, text: string): Promise<void> {
  parseConfig(text, paths);
  await writeFileAtomic(paths.config, text, 0o600, 0o700);
}
