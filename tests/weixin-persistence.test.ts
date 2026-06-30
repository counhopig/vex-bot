import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import yaml from "yaml";

vi.mock("../src/utils/logger.js", () => ({
  getChildLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

let tmpHome = os.tmpdir();
vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return {
    ...actual,
    homedir: () => tmpHome,
  };
});

import { WeixinChannel, WeixinClient } from "../src/channels/weixin/index.js";

describe("Weixin channel persistence", () => {
  let homeDir: string;
  let workDir: string;
  let originalCwd: string;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "vex-weixin-home-"));
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vex-weixin-work-"));
    tmpHome = homeDir;
    originalCwd = process.cwd();
    process.chdir(workDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("persists WebUI QR login tokens to the runtime config path", async () => {
    const configDir = path.join(homeDir, "custom-config");
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, "vex.yaml");
    fs.writeFileSync(
      configPath,
      yaml.stringify({
        channels: {
          weixin: {
            botType: "3",
          },
        },
      }),
      "utf-8",
    );
    vi.spyOn(WeixinClient.prototype, "pollQRStatus").mockResolvedValue({
      status: "confirmed",
      botToken: "wx-token",
      accountId: "wx-account",
    });

    const channel = new WeixinChannel({}, { configPath });

    const result = await channel.checkQRStatus("qr-code");

    expect(result.status).toBe("confirmed");
    expect(fs.existsSync(path.join(workDir, "config.local.yaml"))).toBe(false);
    const saved = yaml.parse(
      fs.readFileSync(configPath, "utf-8"),
    ) as { channels?: { weixin?: { token?: string; accountId?: string; enabled?: boolean; botType?: string } } };
    expect(saved.channels?.weixin).toEqual({
      botType: "3",
      token: "wx-token",
      accountId: "wx-account",
      enabled: true,
    });
  });
});
