/**
 * ConfigStore tests — 3-tier config resolution:
 *   1. Built-in defaults (hardcoded)
 *   2. YAML file (system-level)
 *   3. SQLite web_user_settings (user-level overrides)
 *
 * Architecture doc resolution order (architecture.md §9):
 *   Built-in → config.local.yaml → web_user_settings → EffectiveConfig
 */

import { describe, it, expect } from "vitest";
import { ConfigStore } from "../src/config/ConfigStore.js";
import { YamlLoader } from "../src/config/resolvers/YamlLoader.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vex-config-test-"));
}

function writeYaml(dir: string, data: Record<string, unknown>): string {
  const filePath = path.join(dir, "config.local.yaml");
  const yaml = `# test config\n${Object.entries(data)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n")}`;
  fs.writeFileSync(filePath, yaml, "utf-8");
  return filePath;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("ConfigStore", () => {
  // -- defaults (no YAML, no SQLite) ---------------------------------------

  it("returns built-in defaults when no YAML file exists", async () => {
    const store = new ConfigStore({ yamlLoader: new YamlLoader("/nonexistent/path.yaml") });
    const config = await store.resolve("user1", "webchat");

    expect(config.userId).toBe("user1");
    expect(config.channelId).toBe("webchat");
    // Agent defaults
    expect(config.agent.defaultModel).toBe("deepseek-chat");
    expect(config.agent.defaultProvider).toBe("deepseek");
    expect(config.agent.temperature).toBe(0.7);
    expect(config.agent.maxTokens).toBe(4096);
    // Server defaults
    expect(config.server.port).toBe(3000);
    expect(config.server.host).toBe("127.0.0.1");
    // Logging defaults
    expect(config.logging.level).toBe("info");
  });

  // -- YAML overrides defaults ---------------------------------------------

  it("overlays YAML file values on top of built-in defaults", async () => {
    const dir = tmpDir();
    try {
      const yamlPath = writeYaml(dir, {
        agent: { defaultProvider: "openai", defaultModel: "gpt-4", temperature: 0.5 },
        server: { port: 8080 },
      });
      const store = new ConfigStore({ yamlLoader: new YamlLoader(yamlPath) });
      const config = await store.resolve("user1", "webchat");

      expect(config.agent.defaultProvider).toBe("openai");
      expect(config.agent.defaultModel).toBe("gpt-4");
      expect(config.agent.temperature).toBe(0.5);
      // Should still have default for maxTokens since YAML didn't set it
      expect(config.agent.maxTokens).toBe(4096);
      expect(config.server.port).toBe(8080);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // -- SQLite overrides YAML -----------------------------------------------

  it("overlays SQLite user settings on top of YAML values", async () => {
    const dir = tmpDir();
    try {
      const yamlPath = writeYaml(dir, {
        agent: { defaultProvider: "openai", temperature: 0.5 },
        persona: { enabled: true, persona_name: "YamlBot" },
      });
      const store = new ConfigStore({ yamlLoader: new YamlLoader(yamlPath) });
      const config = await store.resolve("user1", "webchat", {
        persona: { persona_name: "UserBot" },
      });

      // YAML value overridden by SQLite
      expect(config.persona?.persona_name).toBe("UserBot");
      // YAML value (not overridden) still present
      expect(config.persona?.enabled).toBe(true);
      // Default (not in YAML or SQLite) still present
      expect(config.agent.defaultModel).toBe("deepseek-chat");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // -- userId / channelId binding ------------------------------------------

  it("binds userId and channelId in the resolved config", async () => {
    const store = new ConfigStore({ yamlLoader: new YamlLoader("/nonexistent") });
    const config = await store.resolve("alice", "weixin");
    expect(config.userId).toBe("alice");
    expect(config.channelId).toBe("weixin");
  });

  // -- empty YAML file ----------------------------------------------------

  it("handles an empty YAML file gracefully", async () => {
    const dir = tmpDir();
    try {
      const filePath = path.join(dir, "config.local.yaml");
      fs.writeFileSync(filePath, "", "utf-8");
      const store = new ConfigStore({ yamlLoader: new YamlLoader(filePath) });
      const config = await store.resolve("u", "c");
      expect(config.userId).toBe("u");
      expect(config.channelId).toBe("c");
      expect(config.agent.defaultProvider).toBe("deepseek");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // -- YAML merges, does not replace entire sections -----------------------

  it("deep-merges YAML sections instead of replacing them entirely", async () => {
    const dir = tmpDir();
    try {
      const yamlPath = writeYaml(dir, {
        agent: { workingDirectory: "/custom/work" },
      });
      const store = new ConfigStore({ yamlLoader: new YamlLoader(yamlPath) });
      const config = await store.resolve("u", "c");

      // YAML-supplied field
      expect(config.agent.workingDirectory).toBe("/custom/work");
      // Default fields not in YAML should remain
      expect(config.agent.defaultModel).toBe("deepseek-chat");
      expect(config.agent.temperature).toBe(0.7);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // -- SQLite only overrides specified fields ------------------------------

  it("SQLite override does not erase non-overridden fields in the same section", async () => {
    const dir = tmpDir();
    try {
      const yamlPath = writeYaml(dir, {
        agent: { defaultProvider: "openai", defaultModel: "gpt-4", temperature: 0.3 },
      });
      const store = new ConfigStore({ yamlLoader: new YamlLoader(yamlPath) });
      const config = await store.resolve("u", "c", {
        agent: { temperature: 0.9 },
      });

      expect(config.agent.defaultProvider).toBe("openai"); // from YAML
      expect(config.agent.defaultModel).toBe("gpt-4");      // from YAML
      expect(config.agent.temperature).toBe(0.9);            // from SQLite
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects system-owned path and environment fields from legacy user rows", async () => {
    const dir = tmpDir();
    try {
      const yamlPath = writeYaml(dir, {
        agent: { workingDirectory: "/srv/vex", bashEnvPassthrough: ["SAFE"] },
        memory: { directory: "/srv/vex-memory" },
        sessions: { directory: "/srv/vex-sessions" },
      });
      const store = new ConfigStore({ yamlLoader: new YamlLoader(yamlPath) });
      const config = await store.resolve("u", "c", {
        agent: { workingDirectory: "/etc", bashEnvPassthrough: ["SECRET"] },
        memory: { directory: "/tmp/other-user" },
        sessions: { directory: "/tmp/other-user" },
      });

      expect(config.agent.workingDirectory).toBe("/srv/vex");
      expect(config.agent.bashEnvPassthrough).toEqual(["SAFE"]);
      expect(config.memory?.directory).toBe("/srv/vex-memory");
      expect(config.sessions?.directory).toBe("/srv/vex-sessions");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("inherits a system weather key when the user row contains a blank key", async () => {
    const dir = tmpDir();
    try {
      const yamlPath = writeYaml(dir, {
        weather: { weather_provider: "caiyun", caiyun_api_key: "system-key" },
      });
      const store = new ConfigStore({ yamlLoader: new YamlLoader(yamlPath) });
      const config = await store.resolve("u", "c", {
        weather: { caiyun_api_key: "", default_location: "深圳" },
      });

      expect(config.weather?.caiyunApiKey).toBe("system-key");
      expect(config.weather?.defaultLocation).toBe("深圳");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // -- persona disabled by default (opt-in) --------------------------------

  it("does not set persona by default (opt-in)", async () => {
    const store = new ConfigStore({ yamlLoader: new YamlLoader("/nonexistent") });
    const config = await store.resolve("u", "c");
    expect(config.persona).toBeUndefined();
  });

  it("sets persona when configured in YAML", async () => {
    const dir = tmpDir();
    try {
      const yamlPath = writeYaml(dir, {
        persona: { enabled: true, persona_name: "TestBot" },
      });
      const store = new ConfigStore({ yamlLoader: new YamlLoader(yamlPath) });
      const config = await store.resolve("u", "c");
      expect(config.persona?.enabled).toBe(true);
      expect(config.persona?.persona_name).toBe("TestBot");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // -- tier 3 auto-loading via injected UserConfigLoader -------------------

  it("automatically loads user overrides through the injected loader", async () => {
    const loader = {
      load: (userId: string) =>
        userId === "alice" ? { agent: { temperature: 0.2 } } : {},
    };
    const store = new ConfigStore({ yamlLoader: new YamlLoader("/nonexistent"), userConfigLoader: loader });
    const config = await store.resolve("alice", "webchat");

    expect(config.agent.temperature).toBe(0.2);
  });

  it("resolves different users independently without state bleed", async () => {
    const loader = {
      load: (userId: string) =>
        userId === "alice" ? { persona: { persona_name: "AliceBot" } } : { persona: { persona_name: "BobBot" } },
    };
    const store = new ConfigStore({ yamlLoader: new YamlLoader("/nonexistent"), userConfigLoader: loader });
    const alice = await store.resolve("alice", "webchat");
    const bob = await store.resolve("bob", "webchat");

    expect(alice.persona?.persona_name).toBe("AliceBot");
    expect(bob.persona?.persona_name).toBe("BobBot");
    // A second resolve for alice still returns alice's own values.
    expect((await store.resolve("alice", "webchat")).persona?.persona_name).toBe("AliceBot");
  });

  it("applies the loader tier even for users with no settings row (synthetic owners)", async () => {
    const loader = { load: () => ({}) };
    const store = new ConfigStore({ yamlLoader: new YamlLoader("/nonexistent"), userConfigLoader: loader });
    const config = await store.resolve("cron-owner", "weixin");

    expect(config.agent.defaultProvider).toBe("deepseek");
    expect(config.persona).toBeUndefined();
  });

  it("explicit overrides (test escape hatch) still win over the auto-loaded tier", async () => {
    const loader = { load: () => ({ agent: { temperature: 0.2 } }) };
    const store = new ConfigStore({ yamlLoader: new YamlLoader("/nonexistent"), userConfigLoader: loader });
    const config = await store.resolve("u", "c", { agent: { temperature: 0.9 } });

    expect(config.agent.temperature).toBe(0.9);
  });
});
