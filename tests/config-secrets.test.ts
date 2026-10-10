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
});
