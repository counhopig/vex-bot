import { describe, expect, it } from "vitest";
import { configuredSecrets } from "../src/config/secrets.js";
import type { VexConfig } from "../src/config/schema.js";

describe("configuredSecrets", () => {
  it("collects configured credentials, URL credentials and secret-named environment values", () => {
    const config = {
      providers: { openai: { apiKey: "provider-key" } },
      web: { token: "web-token" },
      stt: { baseUrl: "https://user:pass@stt.example/v1?api_key=query-key&model=x", model: "m" },
      vault: { url: "https://git.example/notes.git", username: "git-user", token: "git-token" },
      mcpServers: { local: { command: "node", env: { API_TOKEN: "mcp-env" } }, remote: { url: "https://mcp.example/?token=mcp-query", headers: { Authorization: "Bearer mcp-header" } } },
    } as unknown as VexConfig;
    const secrets = configuredSecrets(config, { MY_SERVICE_TOKEN: "env-token", PATH: "/usr/bin" });
    expect(secrets).toEqual(expect.arrayContaining(["provider-key", "web-token", "user", "pass", "query-key", "git-user", "git-token", "mcp-env", "mcp-query", "Bearer mcp-header", "env-token"]));
    expect(secrets).not.toContain("/usr/bin");
    expect(secrets).not.toContain("x");
    expect(secrets.every((secret) => secret.length > 0)).toBe(true);
  });

  it("ignores secret-named environment settings that are not credentials", () => {
    const config = { providers: {}, web: {} } as unknown as VexConfig;
    const secrets = configuredSecrets(config, { FEATURE_KEYS_FACT: "1", MAX_THINKING_TOKENS: "31999", AUTH_ENABLED: "true", SHORT_TOKEN: "abc", REAL_TOKEN: "ghp_abcdef123456" });
    expect(secrets).toEqual(["ghp_abcdef123456"]);
  });
});
