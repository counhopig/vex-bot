import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/config/load.js";
import { applySettings, readSettings } from "../src/config/settings.js";
import { resolvePaths } from "../src/paths.js";

const paths = resolvePaths("/tmp/vex-settings-test");
const base = `# keep me
model:
  provider: deepseek
  id: deepseek-v4-pro
providers:
  deepseek:
    apiKey: sk-secret
tools:
  policy: { bash: ask }
mcpServers:
  local: { command: node }
`;

describe("settings", () => {
  it("lists editable values and reports secrets without revealing them", () => {
    const view = readSettings(`${base}stt:\n  baseUrl: https://stt.example/v1\n  model: whisper-1\n  apiKey: k\nheartbeat:\n  activeHours: ["08:00", "22:00"]\nlinks:\n  bilibili:\n    sessdata: abc\n`);
    expect(view.values).toMatchObject({ "model.provider": "deepseek", "stt.model": "whisper-1", "heartbeat.activeHours": ["08:00", "22:00"] });
    expect(view.secrets.sort()).toEqual(["links.bilibili.sessdata", "providers.deepseek.apiKey", "stt.apiKey"]);
    expect(JSON.stringify(view)).not.toMatch(/sk-secret|"abc"/);
    expect(Object.keys(view.values)).not.toContain("tools.policy.bash");
  });

  it("edits values while keeping comments and keys the form does not manage", () => {
    const next = applySettings(base, { set: { "model.id": "deepseek-flash", "persona.sleep": ["22:30", "06:30"], "wechat.enabled": false } }, paths);
    expect(next.text).toContain("# keep me");
    expect(next.text).toContain("id: deepseek-flash");
    expect(next.text).toContain("sk-secret");
    expect(next.text).toContain("policy: { bash: ask }");
    expect(next.text).toContain("local: { command: node }");
    expect(readSettings(next.text).values).toMatchObject({ "persona.sleep": ["22:30", "06:30"], "wechat.enabled": false });
    expect(next.restartRequired).toBe(true);
  });

  it("removes cleared values and the sections that became empty", () => {
    const next = applySettings(`${base}stt:\n  baseUrl: https://x\n  model: m\n`, { unset: ["stt.baseUrl", "stt.model"] }, paths);
    expect(next.text).not.toContain("stt");
    expect(applySettings(base, { unset: ["providers.deepseek.apiKey"] }, paths).text).not.toContain("providers");
  });

  it("applies live settings without asking for a restart", () => {
    expect(applySettings(base, { set: { "stt.baseUrl": "https://s/v1", "stt.model": "m", "links.bilibili.sessdata": "x" } }, paths).restartRequired).toBe(false);
  });

  it("refuses unmanaged keys, bad values, invalid YAML and results that fail validation", () => {
    expect(() => applySettings(base, { set: { "web.token": "x" } }, paths)).toThrow("web.token");
    expect(() => applySettings(base, { set: { "tools.policy.bash": "allow" } }, paths)).toThrow(ConfigError);
    expect(() => applySettings(base, { set: { "providers.a.b.apiKey": "x" } }, paths)).toThrow(ConfigError);
    expect(() => applySettings(base, { set: { "stt.baseUrl": {} as never } }, paths)).toThrow("无效");
    expect(() => applySettings("model: [", { set: { "model.id": "x" } }, paths)).toThrow("YAML");
    expect(() => applySettings(base, { set: { "backgroundModel.provider": "deepseek" } }, paths)).toThrow(ConfigError);
    expect(() => applySettings(base, { set: { "heartbeat.every": "500ms" } }, paths)).toThrow(/heartbeat/);
  });
});
