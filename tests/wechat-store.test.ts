import { stat, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WeChatStore } from "../src/channels/wechat/store.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let dir: string;
beforeEach(async () => { dir = await makeTmpDir(); });
afterEach(async () => { await removeTmpDir(dir); });

describe("WeChatStore", () => {
  it("returns nothing before login", async () => {
    const store = new WeChatStore(join(dir, "wechat"));
    expect(await store.loadCredentials()).toBeUndefined();
    expect(await store.loadState()).toEqual({});
  });

  it("saves credentials readable only by the owner", async () => {
    const store = new WeChatStore(join(dir, "wechat"));
    const credentials = { token: "t1", accountId: "bot1", baseUrl: "https://example.test", userId: "owner1" };
    await store.saveCredentials(credentials);
    expect(await store.loadCredentials()).toEqual(credentials);
    expect((await stat(store.credentialsFile)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "wechat"))).mode & 0o777).toBe(0o700);
  });

  it("ignores corrupt or incomplete credentials", async () => {
    const store = new WeChatStore(join(dir, "wechat"));
    await mkdir(join(dir, "wechat"), { recursive: true });
    await writeFile(store.credentialsFile, "{oops", "utf8");
    expect(await store.loadCredentials()).toBeUndefined();
    await writeFile(store.credentialsFile, JSON.stringify({ token: "", baseUrl: "x" }), "utf8");
    expect(await store.loadCredentials()).toBeUndefined();
  });

  it("round-trips the last context token", async () => {
    const store = new WeChatStore(join(dir, "wechat"));
    await store.saveState({ contextToken: "ctx-9" });
    expect(await store.loadState()).toEqual({ contextToken: "ctx-9" });
  });

  it("round-trips the sync cursor alongside the context token", async () => {
    const store = new WeChatStore(join(dir, "wechat"));
    await store.saveState({ contextToken: "ctx-9", syncBuf: "buf-3" });
    expect(await store.loadState()).toEqual({ contextToken: "ctx-9", syncBuf: "buf-3" });
    await store.saveState({ syncBuf: "buf-4" });
    expect(await store.loadState()).toEqual({ syncBuf: "buf-4" });
  });
});
