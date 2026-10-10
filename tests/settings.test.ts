import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/config/load.js";
import { applySettings, isEditable, readSettings } from "../src/config/settings.js";
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
const withVault = "model: { provider: p, id: m }\nvault: { url: https://example.com/v.git }\n";

describe("settings", () => {
  it("stores Jev configuration while hiding its API key", () => {
    const updated = applySettings(base, { set: { "jev.enabled": true, "jev.apiKey": "typesafe-secret", "jev.confidence": 0.8 } }, paths);
    expect(updated.restartRequired).toBe(true);
    const view = readSettings(updated.text);
    expect(view.values).toMatchObject({ "jev.enabled": true, "jev.confidence": 0.8 });
    expect(view.secrets).toContain("jev.apiKey");
    expect(JSON.stringify(view)).not.toContain("typesafe-secret");
    expect(() => applySettings(base, { set: { "jev.confidence": 2 } }, paths)).toThrow(ConfigError);
  });

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

  it("manages the web search provider, key and SearXNG address", () => {
    const next = applySettings(base, { set: { "webSearch.provider": "searxng", "webSearch.baseUrl": "http://searxng:8080" } }, paths);
    expect(readSettings(next.text).values).toMatchObject({ "webSearch.provider": "searxng", "webSearch.baseUrl": "http://searxng:8080" });
    expect(() => applySettings(base, { set: { "webSearch.provider": "bing" } }, paths)).toThrow(/webSearch/);
  });

  it("applies live settings without asking for a restart", () => {
    expect(applySettings(base, { set: { "stt.baseUrl": "https://s/v1", "stt.model": "m", "links.bilibili.sessdata": "x" } }, paths).restartRequired).toBe(false);
  });

  it("refuses unmanaged keys, bad values, invalid YAML and results that fail validation", () => {
    expect(() => applySettings(base, { set: { "web.token": "x" } }, paths)).toThrow("web.token");
    expect(() => applySettings(base, { set: { "tools.policy.bash": "allow" } }, paths)).toThrow(ConfigError);
    expect(() => applySettings(base, { set: { "providers.a.b.apiKey": "x" } }, paths)).toThrow(ConfigError);
    expect(() => applySettings(base, { set: { "stt.baseUrl": {} as never } }, paths)).toThrow("Invalid value");
    expect(() => applySettings("model: [", { set: { "model.id": "x" } }, paths)).toThrow("YAML");
    expect(() => applySettings(base, { set: { "backgroundModel.provider": "deepseek" } }, paths)).toThrow(ConfigError);
    expect(() => applySettings(base, { set: { "heartbeat.every": "500ms" } }, paths)).toThrow(/heartbeat/);
  });

  it("accepts wiki settings under the vault only", () => {
    for (const key of ["vault.wiki.enabled", "vault.wiki.every", "vault.wiki.notify", "vault.wiki.maxNotesPerRun"]) expect(isEditable(key)).toBe(true);
    expect(isEditable("wiki.enabled")).toBe(false);
  });

  it("round-trips a wiki patch", () => {
    const next = applySettings(withVault, { set: { "vault.wiki.enabled": true, "vault.wiki.every": "12h" } }, paths);
    expect(next.restartRequired).toBe(true);
    expect(next.text).toMatch(/vault:[\s\S]*wiki:[\s\S]*enabled: true/);
  });

  it("edits the notes vault and keeps its token secret", () => {
    const view = readSettings(`${base}vault:\n  url: https://git.example/me/notes.git\n  username: me\n  token: tok\n`);
    expect(view.values).toMatchObject({ "vault.url": "https://git.example/me/notes.git", "vault.username": "me" });
    expect(view.secrets).toContain("vault.token");
    expect(JSON.stringify(view)).not.toContain('"tok"');
    const folder = applySettings(base, { set: { "vault.path": "/vault" } }, paths);
    expect(readSettings(folder.text).values).toMatchObject({ "vault.path": "/vault" });
    expect(folder.restartRequired).toBe(true);
    const git = applySettings(folder.text, { set: { "vault.url": "https://git.example/me/notes.git" }, unset: ["vault.path"] }, paths);
    expect(Object.keys(readSettings(git.text).values)).not.toContain("vault.path");
    expect(() => applySettings(folder.text, { set: { "vault.url": "https://git.example/me/notes.git" } }, paths)).toThrow(/either path or url/);
    expect(applySettings(git.text, { unset: ["vault.url"] }, paths).text).not.toContain("vault");
  });
});
