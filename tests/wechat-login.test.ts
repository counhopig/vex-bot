import { stat, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WeChatClient } from "../src/channels/wechat/client.js";
import { loginWithQr, WeChatLoginError } from "../src/channels/wechat/login.js";
import { WeChatStore } from "../src/channels/wechat/store.js";
import { runWeChatLogin } from "../src/cli/wechat.js";
import { resolvePaths, type VexPaths } from "../src/paths.js";
import { FakeIlink } from "./helpers/ilink.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let ilink: FakeIlink;
let dir: string;
let paths: VexPaths;
let qrCount: number;

beforeEach(async () => {
  ilink = new FakeIlink();
  await ilink.start();
  dir = await makeTmpDir();
  paths = resolvePaths(dir);
  qrCount = 0;
  ilink.on("/ilink/bot/get_bot_qrcode", () => {
    qrCount++;
    return { qrcode: `q${qrCount}`, qrcode_img_content: `https://login.example/q${qrCount}` };
  });
});
afterEach(async () => {
  await ilink.stop();
  await removeTmpDir(dir);
});

function statuses(...list: unknown[]): void {
  ilink.on("/ilink/bot/get_qrcode_status", () => list.shift() ?? { status: "wait" });
}

const confirmed = { status: "confirmed", bot_token: "tok", ilink_bot_id: "bot1", baseurl: "https://api2.example", ilink_user_id: "owner1" };

describe("loginWithQr", () => {
  it("shows a QR code and waits for confirmation", async () => {
    statuses({ status: "wait" }, { status: "scaned" }, confirmed);
    const output: string[] = [];
    const result = await loginWithQr(new WeChatClient({ baseUrl: ilink.baseUrl }), (t) => output.push(t), { pollIntervalMs: 1 });
    expect(result).toEqual({ token: "tok", accountId: "bot1", baseUrl: "https://api2.example", userId: "owner1" });
    expect(output[0]).toBe("用手机微信扫描下面的二维码登录：");
    expect(output[1]).toContain("▄");
  });

  it("refreshes an expired QR code", async () => {
    statuses({ status: "expired" }, confirmed);
    const output: string[] = [];
    await loginWithQr(new WeChatClient({ baseUrl: ilink.baseUrl }), (t) => output.push(t), { pollIntervalMs: 1 });
    expect(qrCount).toBe(2);
    expect(output).toContain("二维码已过期，正在刷新…");
  });

  it("gives up after repeated expiry, cancellation or persistent errors", async () => {
    const client = new WeChatClient({ baseUrl: ilink.baseUrl });
    statuses({ status: "expired" }, { status: "expired" });
    await expect(loginWithQr(client, () => {}, { pollIntervalMs: 1, maxQrRefreshes: 2 })).rejects.toThrow(WeChatLoginError);
    statuses({ status: "cancel" });
    await expect(loginWithQr(client, () => {}, { pollIntervalMs: 1 })).rejects.toThrow(/取消/);
    ilink.on("/ilink/bot/get_qrcode_status", () => 500);
    await expect(loginWithQr(client, () => {}, { pollIntervalMs: 1, maxConsecutiveErrors: 2 })).rejects.toThrow(/HTTP 500/);
  });

  it("rides out a transient polling error", async () => {
    const responses: unknown[] = [500, confirmed];
    ilink.on("/ilink/bot/get_qrcode_status", () => responses.shift());
    await expect(loginWithQr(new WeChatClient({ baseUrl: ilink.baseUrl }), () => {}, { pollIntervalMs: 1 })).resolves.toMatchObject({ token: "tok" });
  });
});

describe("runWeChatLogin", () => {
  it("saves owner-only credentials and explains the next step", async () => {
    await writeFile(paths.config, `model: { provider: deepseek, id: deepseek-v4-pro }\nwechat: { baseUrl: "${ilink.baseUrl}" }\n`, "utf8");
    statuses(confirmed);
    const output: string[] = [];
    await runWeChatLogin((t) => output.push(t), paths, { pollIntervalMs: 1 });
    const store = new WeChatStore(paths.wechat);
    expect(await store.loadCredentials()).toEqual({ token: "tok", accountId: "bot1", baseUrl: "https://api2.example", userId: "owner1" });
    expect((await stat(store.credentialsFile)).mode & 0o777).toBe(0o600);
    expect(output).toContain("已绑定微信，主人是扫码的这个微信号（owner1）。");
    expect(output.at(-1)).toBe("vexd 运行中会在几秒内自动接入。");
  });

  it("stores a login base URL only when it is https", async () => {
    await writeFile(paths.config, `model: { provider: deepseek, id: deepseek-v4-pro }\nwechat: { baseUrl: "${ilink.baseUrl}" }\n`, "utf8");
    const store = new WeChatStore(paths.wechat);
    for (const baseurl of ["http://evil.example", "not a url", "ftp://x.example"]) {
      statuses({ ...confirmed, baseurl });
      await runWeChatLogin(() => {}, paths, { pollIntervalMs: 1 });
      expect((await store.loadCredentials())?.baseUrl).toBe(ilink.baseUrl);
    }
    statuses(confirmed);
    await runWeChatLogin(() => {}, paths, { pollIntervalMs: 1 });
    expect((await store.loadCredentials())?.baseUrl).toBe("https://api2.example");
  });

  it("warns when the scanner id is missing and no owner is configured", async () => {
    await writeFile(paths.config, `model: { provider: deepseek, id: deepseek-v4-pro }\nwechat: { baseUrl: "${ilink.baseUrl}" }\n`, "utf8");
    statuses({ status: "confirmed", bot_token: "tok" });
    const output: string[] = [];
    await runWeChatLogin((t) => output.push(t), paths, { pollIntervalMs: 1 });
    expect(output.some((line) => line.includes("wechat.ownerId"))).toBe(true);
    expect((await new WeChatStore(paths.wechat).loadCredentials())?.baseUrl).toBe(ilink.baseUrl);
  });
});
