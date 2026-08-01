/**
 * CLI tests — config loading/validation and the models listing helper.
 *
 * The interactive commands (onboard wizard, chat REPL, logs follow, start's
 * long-running server) are intentionally not covered here — they're process-
 * bound. The testable surface is the config layer (path resolution, required
 * validation) and the pure model listing.
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { writeFileSync, mkdirSync } from "fs";
import { loadConfig, resolveConfigPath, validateRequiredConfig } from "../src/cli/config.js";
import { listModels } from "../src/cli/models.js";
import { checkConfig } from "../src/cli/check.js";

const tempDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vex-cli-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeConfig(dir: string, content: string): string {
  const file = path.join(dir, "config.local.yaml");
  writeFileSync(file, content, "utf-8");
  return file;
}

describe("loadConfig", () => {
  it("loads a valid YAML config with providers and agent defaults", () => {
    const dir = tmpDir();
    const file = writeConfig(dir, [
      "providers:",
      "  deepseek:",
      "    apiKey: sk-test",
      "agent:",
      "  defaultProvider: deepseek",
      "  defaultModel: deepseek-chat",
      "server:",
      "  port: 4321",
      "",
    ].join("\n"));

    const config = loadConfig({ configPath: file });
    expect((config.providers as Record<string, { apiKey?: string }>).deepseek?.apiKey).toBe("sk-test");
    expect((config.agent as Record<string, unknown>).defaultProvider).toBe("deepseek");
    expect((config.server as Record<string, unknown>).port).toBe(4321);
  });

  it("merges built-in defaults for missing agent/server scalars", () => {
    const dir = tmpDir();
    const file = writeConfig(dir, "providers:\n  deepseek:\n    apiKey: sk-test\n");

    const config = loadConfig({ configPath: file });
    const agent = config.agent as Record<string, unknown>;
    expect(agent.defaultProvider).toBe("deepseek");
    expect(agent.defaultModel).toBe("deepseek-chat");
    expect((config.server as Record<string, unknown>).port).toBe(3000);
  });

  it("resolveConfigPath returns the explicit path when provided", () => {
    const dir = tmpDir();
    const file = path.join(dir, "custom.yaml");
    expect(resolveConfigPath(file)).toBe(file);
  });
});

describe("validateRequiredConfig", () => {
  it("passes when a provider has an API key and weixin is enabled", () => {
    const errors = validateRequiredConfig({
      providers: { deepseek: { apiKey: "sk-test" } },
      channels: { weixin: { enabled: true } },
    });
    expect(errors).toEqual([]);
  });

  it("flags missing provider API keys", () => {
    const errors = validateRequiredConfig({
      providers: {},
      channels: { weixin: { enabled: true } },
    });
    expect(errors.some((e) => e.includes("At least one model provider"))).toBe(true);
  });

  it("flags missing channels unless webOnly", () => {
    const errors = validateRequiredConfig({
      providers: { deepseek: { apiKey: "sk-test" } },
      channels: {},
    });
    expect(errors.some((e) => e.includes("communication channel"))).toBe(true);

    const webOnly = validateRequiredConfig(
      { providers: { deepseek: { apiKey: "sk-test" } }, channels: {} },
      { webOnly: true },
    );
    expect(webOnly).toEqual([]);
  });
});

describe("listModels", () => {
  it("returns an empty list when no providers are configured", () => {
    const models = listModels({ providers: {} });
    expect(models).toEqual([]);
  });

  it("returns configured china-provider models", () => {
    const models = listModels({
      providers: { deepseek: { apiKey: "sk-test" } },
    });
    expect(models.length).toBeGreaterThan(0);
    const deepseek = models.find((m) => m.provider === "deepseek");
    expect(deepseek?.modelId).toBe("deepseek-chat");
    expect(typeof deepseek?.supportsVision).toBe("boolean");
  });
});

describe("checkConfig", () => {
  it("prints a report for a valid config", () => {
    const dir = tmpDir();
    const file = writeConfig(dir, "providers:\n  deepseek:\n    apiKey: sk-test\n");
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      // checkConfig loads from CWD config.local.yaml; silence stdout noise by
      // just asserting it doesn't throw.
      expect(() => checkConfig({ configPath: file })).not.toThrow();
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("throws on an invalid YAML config", () => {
    const dir = tmpDir();
    const file = writeConfig(dir, "providers: [not-an-object");
    expect(() => checkConfig({ configPath: file })).toThrow();
  });
});
