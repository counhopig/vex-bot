#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, open, stat } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig } from "../config/load.js";
import { startDaemon, type Daemon } from "../daemon.js";
import { clearPendingReload, readPendingReload, rollbackReload } from "../config/reload.js";
import { createLogger } from "../logger.js";
import { resolvePaths, type VexPaths } from "../paths.js";
import { runOnboard } from "./onboard.js";
import { isAlive, readPid, removePid, tailLines, waitUntil, writePid } from "./process.js";
import { runWeChatLogin } from "./wechat.js";

const USAGE = [
  "Usage: vex <command>",
  "  start [-d]          start vexd (-d runs it in the background)",
  "  stop                stop the background vexd",
  "  status              show whether it is running",
  "  logs [-f]           show the log (-f follows it)",
  "  onboard [--force]   create the initial configuration",
  "  wechat login        link WeChat by QR code",
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
  console.log("Not configured yet; starting setup.");
  if (await onboard(paths, false) !== 0) throw new Error("Setup did not finish");
}

/** Replaces this process with a fresh vexd, keeping the pid, so saved settings apply without a manual restart. */
function reexec(): never {
  process.execve!(process.execPath, [process.execPath, ...process.execArgv, ...process.argv.slice(1)], process.env);
  throw new Error("execve returned");
}

async function startForeground(paths: VexPaths): Promise<number> {
  await ensureConfig(paths);
  const existing = await runningPid(paths);
  if (existing && existing !== process.pid) {
    console.error(`vexd is already running (pid ${existing})`);
    return 1;
  }
  const log = createLogger({ file: paths.logFile, stdout: process.env.VEX_LOG_STDOUT === "1" });
  const canRestart = typeof process.execve === "function";
  const pending = await readPendingReload(paths);
  let daemon: Daemon | undefined;
  try {
    const { config } = await loadConfig(paths);
    daemon = await startDaemon({
      paths,
      config,
      log,
      restart: canRestart ? async () => {
        log.info("restarting to apply saved settings");
        await daemon!.stop();
        log.flush();
        reexec();
      } : undefined,
    });
  } catch (err) {
    if (pending && canRestart) {
      log.error({ err }, "saved settings could not start; restoring the previous configuration");
      await rollbackReload(paths, pending, err);
      log.flush();
      reexec();
    }
    throw err;
  }
  await clearPendingReload(paths);
  await writePid(paths.pidFile, process.pid);
  console.log(`vexd started: ${daemon.url}`);
  return new Promise((resolve) => {
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      void daemon!
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
    console.error(`vexd is already running (pid ${existing})`);
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
    console.error("vexd failed to start; run vex logs to see why");
    return 1;
  }
  console.log(`vexd started in the background (pid ${child.pid}): http://${config.web.host}:${config.web.port}`);
  return 0;
}

async function stop(paths: VexPaths): Promise<number> {
  const pid = await runningPid(paths);
  if (!pid) {
    await removePid(paths.pidFile);
    console.log("vexd is not running");
    return 0;
  }
  process.kill(pid, "SIGTERM");
  const stopped = await waitUntil(async () => (await runningPid(paths)) !== pid, 10_000);
  console.log(stopped ? "vexd stopped" : `vexd did not exit within 10 seconds (pid ${pid})`);
  return stopped ? 0 : 1;
}

async function status(paths: VexPaths): Promise<number> {
  const pid = await runningPid(paths);
  if (!pid) {
    console.log("vexd is not running");
    return 1;
  }
  const { config } = await loadConfig(paths);
  console.log(`vexd is running (pid ${pid}): http://${config.web.host}:${config.web.port}`);
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
