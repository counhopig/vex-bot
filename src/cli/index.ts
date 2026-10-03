#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, open, stat } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig } from "../config/load.js";
import { startDaemon } from "../daemon.js";
import { createLogger } from "../logger.js";
import { resolvePaths, type VexPaths } from "../paths.js";
import { runOnboard } from "./onboard.js";
import { isAlive, readPid, removePid, tailLines, waitUntil, writePid } from "./process.js";
import { runWeChatLogin } from "./wechat.js";

const USAGE = [
  "用法：vex <命令>",
  "  start [-d]          启动 vexd（-d 在后台运行）",
  "  stop                停止后台运行的 vexd",
  "  status              查看运行状态",
  "  logs [-f]           查看日志（-f 持续输出）",
  "  onboard [--force]   生成初始配置",
  "  wechat login        扫码绑定微信",
].join("\n");

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const paths = resolvePaths();
  switch (command) {
    case "start": {
      const { values } = parseArgs({ args: rest, options: { daemon: { type: "boolean", short: "d" } } });
      return values.daemon ? startBackground(paths) : startForeground(paths);
    }
    case "stop":
      return stop(paths);
    case "status":
      return status(paths);
    case "logs": {
      const { values } = parseArgs({ args: rest, options: { follow: { type: "boolean", short: "f" } } });
      return logs(paths, values.follow ?? false);
    }
    case "onboard": {
      const { values } = parseArgs({ args: rest, options: { force: { type: "boolean" } } });
      return onboard(paths, values.force ?? false);
    }
    case "wechat":
      if (rest[0] === "login") {
        await runWeChatLogin((text) => console.log(text), paths);
        return 0;
      }
      console.log(USAGE);
      return 1;
    default:
      console.log(USAGE);
      return command ? 1 : 0;
  }
}

async function runningPid(paths: VexPaths): Promise<number | undefined> {
  const pid = await readPid(paths.pidFile);
  return pid !== undefined && isAlive(pid) ? pid : undefined;
}

async function ensureConfig(paths: VexPaths): Promise<void> {
  if (!process.stdin.isTTY || (await stat(paths.config).then(() => true, () => false))) return;
  console.log("尚未配置，开始初始化。");
  if (await onboard(paths, false) !== 0) throw new Error("初始化未完成");
}

async function startForeground(paths: VexPaths): Promise<number> {
  await ensureConfig(paths);
  const { config } = await loadConfig(paths);
  const existing = await runningPid(paths);
  if (existing) {
    console.error(`vexd 已在运行（pid ${existing}）`);
    return 1;
  }
  const log = createLogger({ file: paths.logFile, stdout: process.env.VEX_LOG_STDOUT === "1" });
  const daemon = await startDaemon({ paths, config, log });
  await writePid(paths.pidFile, process.pid);
  console.log(`vexd 已启动：${daemon.url}`);
  return new Promise((resolve) => {
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      void daemon
        .stop()
        .then(() => removePid(paths.pidFile))
        .catch((err: unknown) => log.error({ err }, "shutdown failed"))
        .finally(() => {
          log.flush();
          resolve(0);
        });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

async function startBackground(paths: VexPaths): Promise<number> {
  await ensureConfig(paths);
  const { config } = await loadConfig(paths);
  const existing = await runningPid(paths);
  if (existing) {
    console.error(`vexd 已在运行（pid ${existing}）`);
    return 1;
  }
  await mkdir(paths.logs, { recursive: true });
  const out = await open(paths.logFile, "a");
  const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "start"], {
    detached: true,
    stdio: ["ignore", out.fd, out.fd],
    env: process.env,
  });
  child.unref();
  await out.close();
  const started = await waitUntil(async () => (await runningPid(paths)) === child.pid, 15_000);
  if (!started) {
    console.error("vexd 未能启动，运行 vex logs 查看原因");
    return 1;
  }
  console.log(`vexd 已在后台启动（pid ${child.pid}）：http://${config.web.host}:${config.web.port}`);
  return 0;
}

async function stop(paths: VexPaths): Promise<number> {
  const pid = await runningPid(paths);
  if (!pid) {
    await removePid(paths.pidFile);
    console.log("vexd 未在运行");
    return 0;
  }
  process.kill(pid, "SIGTERM");
  const stopped = await waitUntil(async () => (await runningPid(paths)) !== pid, 10_000);
  console.log(stopped ? "vexd 已停止" : `vexd 未在 10 秒内退出（pid ${pid}）`);
  return stopped ? 0 : 1;
}

async function status(paths: VexPaths): Promise<number> {
  const pid = await runningPid(paths);
  if (!pid) {
    console.log("vexd 未在运行");
    return 1;
  }
  const { config } = await loadConfig(paths);
  console.log(`vexd 运行中（pid ${pid}）：http://${config.web.host}:${config.web.port}`);
  return 0;
}

async function logs(paths: VexPaths, follow: boolean): Promise<number> {
  for (const line of await tailLines(paths.logFile, 200)) console.log(line);
  if (!follow) return 0;
  let offset = await fileSize(paths.logFile);
  for (;;) {
    await delay(500);
    const size = await fileSize(paths.logFile);
    if (size < offset) offset = 0;
    if (size === offset) continue;
    const handle = await open(paths.logFile, "r");
    const buffer = Buffer.alloc(size - offset);
    await handle.read(buffer, 0, buffer.length, offset);
    await handle.close();
    process.stdout.write(buffer);
    offset = size;
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function onboard(paths: VexPaths, force: boolean): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ok = await runOnboard({ ask: (q) => rl.question(q), print: (line) => console.log(line) }, paths, { force });
    return ok ? 0 : 1;
  } finally {
    rl.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
