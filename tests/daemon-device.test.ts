import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, type FauxProviderHandle } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { VexConfig } from "../src/config/schema.js";
import { startDaemon, type Daemon } from "../src/daemon.js";
import { createLogger } from "../src/logger.js";
import { resolvePaths, type VexPaths } from "../src/paths.js";
import type { DeviceClientMessage, DeviceServerMessage } from "../src/protocol/device.js";
import { createModelRegistry } from "../src/providers/models.js";
import { TestClient } from "./helpers/client.js";
import { createFaux, fauxModels } from "./helpers/faux.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

const TOKEN = "device-secret-token";

class DeviceClient {
  readonly messages: DeviceServerMessage[] = [];
  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (data) => this.messages.push(JSON.parse(data.toString()) as DeviceServerMessage));
  }

  static connect(port: number, headers: Record<string, string>): Promise<DeviceClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/device/ws`, { headers });
      const client = new DeviceClient(ws);
      ws.once("open", () => resolve(client));
      ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.once("error", reject);
    });
  }

  send(message: DeviceClientMessage): void {
    this.ws.send(JSON.stringify(message));
  }

  waitFor(predicate: (m: DeviceServerMessage) => boolean): Promise<DeviceServerMessage> {
    return vi.waitFor(() => {
      const found = this.messages.find(predicate);
      if (!found) throw new Error("message not received yet");
      return found;
    }, { timeout: 5000, interval: 10 });
  }

  close(): void {
    this.ws.close();
  }
}

let dir: string;
let paths: VexPaths;
let faux: FauxProviderHandle;
let daemon: Daemon | undefined;
let device: DeviceClient | undefined;

beforeEach(async () => {
  dir = await makeTmpDir();
  paths = resolvePaths(dir);
  faux = createFaux();
});
afterEach(async () => {
  device?.close();
  device = undefined;
  await daemon?.stop();
  daemon = undefined;
  await removeTmpDir(dir);
});

function config(overrides: Partial<VexConfig> = {}): VexConfig {
  return {
    model: { provider: faux.getModel().provider, id: faux.getModel().id },
    backgroundModel: { provider: faux.getModel().provider, id: faux.getModel().id },
    providers: {},
    web: { host: "127.0.0.1", port: 0 },
    workspace: join(dir, "workspace"),
    toolPolicy: {},
    bashEnvPassthrough: [],
    wechat: { enabled: false, baseUrl: "http://127.0.0.1:1" },
    device: { token: TOKEN, label: "Desk device" },
    ...overrides,
  };
}

async function start(cfg: VexConfig = config()): Promise<Daemon> {
  daemon = await startDaemon({ paths, config: cfg, log: createLogger(), models: createModelRegistry({}, fauxModels(faux)) });
  return daemon;
}

describe("vexd device endpoint", () => {
  it("answers a device message in its own session with a prompt asking for spoken replies", async () => {
    let prompt = "";
    faux.setResponses([(ctx) => { prompt = getCurrentSystemPrompt(ctx.messages); return fauxAssistantMessage("下午三点开会。"); }]);
    const { port } = await start();
    device = await DeviceClient.connect(port, { Authorization: `Bearer ${TOKEN}` });
    await device.waitFor((m) => m.type === "hello");
    device.send({ type: "send", id: "a1", text: "今天有什么安排" });
    expect(await device.waitFor((m) => m.type === "reply")).toEqual({ type: "reply", ids: ["a1"], text: "下午三点开会。", status: "ok" });
    expect(device.messages.map((m) => m.type)).toEqual(["hello", "busy", "accepted", "busy", "reply"]);
    expect(prompt).toContain("Window: Desk device (replies are read aloud");
    expect(await readFile(join(paths.sessions, "device.jsonl"), "utf8")).toContain("今天有什么安排");
  });

  it("refuses a wrong token, a browser origin and the web cookie route", async () => {
    const { port } = await start(config({ web: { host: "127.0.0.1", port: 0, token: "web-token" } }));
    await expect(DeviceClient.connect(port, { Authorization: "Bearer wrong" })).rejects.toThrow("HTTP 401");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await expect(DeviceClient.connect(port, { Authorization: `Bearer ${TOKEN}`, Origin: `http://127.0.0.1:${port}` })).rejects.toThrow("HTTP 403");
    // The device token is not a web login.
    await expect(TestClient.connect(`ws://127.0.0.1:${port}/ws`, { cookie: `vex_auth=${TOKEN}` })).rejects.toThrow();
  });

  it("does not exist without a device token", async () => {
    const { port } = await start(config({ device: undefined }));
    await expect(DeviceClient.connect(port, { Authorization: `Bearer ${TOKEN}` })).rejects.toThrow("HTTP 404");
  });

  it("delivers a schedule created from the device back to the device", async () => {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("schedule", { action: "create", name: "stretch", schedule: { once: new Date(Date.now() + 1500).toISOString() }, prompt: "remind the owner to stretch" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("好的"),
      fauxAssistantMessage("该起来活动一下了"),
    ]);
    const { port } = await start();
    device = await DeviceClient.connect(port, { Authorization: `Bearer ${TOKEN}` });
    device.send({ type: "send", id: "a1", text: "一会儿提醒我活动" });
    await device.waitFor((m) => m.type === "reply" && m.text === "好的");
    const tasks = JSON.parse(await readFile(join(paths.home, "schedules.json"), "utf8"));
    expect(tasks[0].target).toBe("device");
    expect(await device.waitFor((m) => m.type === "reply" && m.text === "该起来活动一下了")).toMatchObject({ ids: [], status: "ok" });
  });
});
