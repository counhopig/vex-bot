#!/usr/bin/env node

/**
 * Vex CLI — operational commands.
 *
 * start/stop/restart/status/logs/check/models wire into the new architecture:
 * ConfigStore (YamlLoader), ModelResolver, and the web/server.ts bootstrap.
 * The `chat` command is an operator diagnostic (bare pi-ai connectivity test,
 * no Agent/Persona/Tools) and the `onboard` wizard writes ~/.vex/config.local.yaml.
 */

// Node.js v24+ undici strictly validates ByteString headers, but some API
// providers (e.g. MiniMax) return non-ASCII characters in response headers.
// Patch global fetch to sanitize response headers before they reach undici's
// header parser (provider-layer compat, moved from cli/fetch-patch.ts).
import { applyFetchCompatPatch } from "../providers/fetch-compat.js";
applyFetchCompatPatch();

import { Command } from "commander";
import { homedir } from "os";
import { join } from "path";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { spawn, execSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname } from "path";

import { loadConfig, validateRequiredConfig } from "./config.js";
import { startWebServer } from "./server.js";
import { runOnboardWizard } from "./onboard.js";

// Read version from package.json
const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = join(__dirname, "..", "..", "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));

const program = new Command();

program
  .name("vex")
  .description("Vex - AI assistant supporting Chinese LLMs and communication platforms")
  .version(packageJson.version);

/**
 * Find PIDs of running Vex service processes.
 *
 * Uses `pgrep` only to *list* candidate PIDs; it never kills by pattern.
 * The current process is excluded so `restart`/`stop` cannot signal
 * themselves, and callers always send signals to explicit numeric PIDs
 * (via process.kill) rather than a broad `pkill -f`.
 */
function findVexPids(): number[] {
  const raw = execSync('pgrep -f "node.*dist/cli.*start" 2>/dev/null || echo ""', { encoding: "utf-8" });
  return raw
    .trim()
    .split("\n")
    .map((line) => parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}

/** Send a signal to each PID individually; returns PIDs that were still alive to signal. */
function signalPids(pids: number[], signal: NodeJS.Signals): number[] {
  const signalled: number[] = [];
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
      signalled.push(pid);
    } catch (err) {
      // ESRCH: process already gone — nothing to do.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") {
        console.error(`Cannot signal process ${pid}:`, err instanceof Error ? err.message : err);
      }
    }
  }
  return signalled;
}

// Start command
program
  .command("start")
  .description("Start Gateway server")
  .option("-c, --config <path>", "Config file path")
  .option("-p, --port <port>", "Server port")
  .option("--host <host>", "Bind address (default 127.0.0.1; use 0.0.0.0 to expose on all interfaces)")
  .option("--web-only", "WebChat only (no channel configuration required)")
  .action(async (options) => {
    try {
      const config = loadConfig({ configPath: options.config });

      if (options.port) {
        config.server = { ...(config.server ?? {}), port: parseInt(options.port, 10) };
      }
      if (options.host) {
        config.server = { ...(config.server ?? {}), host: options.host };
      }

      const errors = validateRequiredConfig(config, { webOnly: options.webOnly });
      if (errors.length > 0) {
        console.error("ERROR: Configuration error:");
        errors.forEach((err: string) => console.error(`   - ${err}`));
        process.exit(1);
      }

      await startWebServer(config);
    } catch (error) {
      console.error("ERROR: Startup failed:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Model listing command
program
  .command("models")
  .description("List available models")
  .action(async () => {
    try {
      const config = loadConfig();
      const { listModels } = await import("./models.js");
      const models = listModels(config);

      if (models.length === 0) {
        console.log("No model providers configured. Please check API Key configuration.");
        return;
      }

      console.log("\nAvailable models:\n");

      const byProvider = new Map<string, typeof models>();
      for (const item of models) {
        const list = byProvider.get(item.provider) || [];
        list.push(item);
        byProvider.set(item.provider, list);
      }

      for (const [provider, list] of byProvider) {
        console.log(`📦 ${provider.toUpperCase()}`);
        for (const item of list) {
          const vision = item.supportsVision ? " 👁️" : "";
          const reasoning = item.supportsReasoning ? " 🧠" : "";
          console.log(`   - ${item.modelId} (${item.name})${vision}${reasoning}`);
        }
        console.log("");
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Configuration check command
program
  .command("check")
  .description("Check configuration")
  .option("-c, --config <path>", "Config file path")
  .action(async (options) => {
    try {
      const { checkConfig } = await import("./check.js");
      checkConfig({ configPath: options.config });
    } catch (error) {
      console.error("ERROR: Configuration error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Chat test command
program
  .command("chat")
  .description("Test chat functionality")
  .option("-m, --model <model>", "Model to use")
  .option("-p, --provider <provider>", "Provider to use")
  .action(async (options) => {
    try {
      const config = loadConfig();
      const { runChat } = await import("./chat.js");
      await runChat(config, { model: options.model, provider: options.provider });
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Configuration wizard command
program
  .command("onboard")
  .description("Configuration wizard (model/platform/server/Agent/memory)")
  .action(async () => {
    await runOnboardWizard();
  });

// Stop service command
program
  .command("kill")
  .alias("stop")
  .description("Stop running Vex service")
  .action(async () => {
    try {
      const pids = findVexPids();

      if (pids.length === 0) {
        console.log("No running Vex service found");
        return;
      }

      console.log(`Found ${pids.length} Vex process(es): ${pids.join(", ")}`);

      for (const pid of signalPids(pids, "SIGTERM")) {
        console.log(`Termination signal sent to process ${pid}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));

      const stillAlive = findVexPids().filter((pid) => pids.includes(pid));
      if (stillAlive.length > 0) {
        console.log(`Some processes still running (${stillAlive.join(", ")}), forcing kill...`);
        signalPids(stillAlive, "SIGKILL");
      }

      console.log("Vex service stopped");
    } catch (error) {
      console.error("Error stopping service:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Restart service command
program
  .command("restart")
  .description("Restart Vex service (the new service runs in this terminal's foreground; closing the terminal stops it)")
  .option("-c, --config <path>", "Config file path")
  .option("-p, --port <port>", "Server port")
  .option("--web-only", "WebChat only")
  .action(async (options) => {
    console.log("Restarting Vex service...\n");

    try {
      const pids = findVexPids();
      if (pids.length > 0) {
        console.log(`Stopping existing service (PID: ${pids.join(", ")})...`);
        signalPids(pids, "SIGTERM");
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const stillAlive = findVexPids().filter((pid) => pids.includes(pid));
        if (stillAlive.length > 0) {
          signalPids(stillAlive, "SIGKILL");
        }
      }
    } catch {
      // Ignore stop errors; the start below reports real failures.
    }

    console.log("Starting new service...\n");

    try {
      const config = loadConfig({ configPath: options.config });
      if (options.port) {
        config.server = { ...(config.server ?? {}), port: parseInt(options.port, 10) };
      }
      const errors = validateRequiredConfig(config, { webOnly: options.webOnly });
      if (errors.length > 0) {
        console.error("ERROR: Configuration error:");
        errors.forEach((err: string) => console.error(`   - ${err}`));
        process.exit(1);
      }
      await startWebServer(config);
    } catch (error) {
      console.error("Restart failed:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Service status command
program
  .command("status")
  .description("View Vex service status")
  .action(async () => {
    console.log("\nVex Service Status\n");

    try {
      const result = execSync('ps aux | grep -E "node.*dist/cli.*start" | grep -v grep 2>/dev/null || echo ""', { encoding: "utf-8" });
      const lines = result.trim().split("\n").filter(Boolean);

      if (lines.length === 0) {
        console.log("Status: Not running");
        console.log("\nTip: Use 'vex start' or 'vex start --web-only' to start the service");
        return;
      }

      console.log("Status: Running");
      console.log(`Process count: ${lines.length}\n`);

      for (const line of lines) {
        const parts = line.split(/\s+/);
        const pid = parts[1];
        const cpu = parts[2];
        const mem = parts[3];
        const time = parts[9];
        const cmd = parts.slice(10).join(" ").slice(0, 60);

        console.log(`  PID: ${pid}`);
        console.log(`  CPU: ${cpu}%  Memory: ${mem}%`);
        console.log(`  Uptime: ${time}`);
        console.log(`  Command: ${cmd}...`);
        console.log("");
      }

      try {
        const config = loadConfig();
        const port = (config.server as { port?: number } | undefined)?.port || 3000;
        const health = execSync(`curl -s http://localhost:${port}/health 2>/dev/null || echo ""`, { encoding: "utf-8" }).trim();
        if (health) {
          const healthData = JSON.parse(health) as { status: string };
          console.log(`Health check: ${healthData.status}`);
          console.log(`Service URL: http://localhost:${port}`);
        }
      } catch {
        // Ignore health check errors
      }
    } catch (error) {
      console.error("Error checking status:", error instanceof Error ? error.message : error);
    }
  });

// Log viewing command
program
  .command("logs")
  .description("View logs")
  .option("-f, --follow", "Follow log output (like tail -f)")
  .option("-n, --lines <number>", "Show last N lines", "50")
  .option("-l, --list", "List all log files")
  .option("--date <date>", "Show logs for specific date (format: YYYY-MM-DD)")
  .option("--level <level>", "Filter by log level (debug, info, warn, error)")
  .option("--pretty", "Pretty output (on by default)", true)
  .action(async (options) => {
    const { getLogDir, getLogFile } = await import("../utils/logger.js");
    const logDir = getLogDir();

    if (options.list) {
      console.log(`\nLog directory: ${logDir}\n`);

      if (!existsSync(logDir)) {
        console.log("No log files found");
        return;
      }

      const files = readdirSync(logDir).filter((f) => f.endsWith(".log")).sort().reverse();
      if (files.length === 0) {
        console.log("No log files found");
        return;
      }

      console.log("Log files:");
      for (const file of files) {
        const filePath = join(logDir, file);
        const stats = statSync(filePath);
        const size = (stats.size / 1024).toFixed(1);
        console.log(`  ${file}  (${size} KB)`);
      }
      return;
    }

    let logFile: string;
    if (options.date) {
      logFile = join(logDir, `vex-${options.date}.log`);
    } else {
      logFile = getLogFile();
    }

    if (!existsSync(logFile)) {
      console.error(`Log file not found: ${logFile}`);
      console.log(`\nTip: Use 'vex logs --list' to view all log files`);
      return;
    }

    console.log(`Log files: ${logFile}\n`);

    if (options.follow) {
      console.log("Following logs... (Ctrl+C to exit)\n");

      const args = ["-f", logFile];
      if (options.lines) args.unshift("-n", options.lines);

      const tail = spawn("tail", args, { stdio: "pipe" });

      tail.stdout.on("data", (data: Buffer) => {
        for (const line of data.toString().split("\n")) {
          if (!line.trim()) continue;
          printLogLine(line, options.level, options.pretty);
        }
      });
      tail.stderr.on("data", (data: Buffer) => console.error(data.toString()));
      process.on("SIGINT", () => {
        tail.kill();
        process.exit(0);
      });
      return;
    }

    const content = readFileSync(logFile, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());
    const lastN = parseInt(options.lines, 10) || 50;
    const displayLines = lines.slice(-lastN);
    for (const line of displayLines) printLogLine(line, options.level, options.pretty);

    console.log(`\nShowing last ${displayLines.length} log entries`);
    console.log(`Tip: Use 'vex logs -f' to follow logs in real time`);
  });

/** Print log line */
function printLogLine(line: string, levelFilter?: string, pretty?: boolean): void {
  try {
    const log = JSON.parse(line) as Record<string, unknown>;

    if (levelFilter) {
      const levelOrder = ["debug", "info", "warn", "error"];
      const logLevel = levelOrder.indexOf(String(log.level ?? "info"));
      const filterLevel = levelOrder.indexOf(levelFilter);
      if (logLevel < filterLevel) return;
    }

    if (pretty) {
      const time = typeof log.time === "number" ? new Date(log.time).toLocaleString() : "";
      const level = String(log.level ?? "INFO").toUpperCase().padEnd(5);
      const module = log.module ? `[${String(log.module)}]` : "";
      const msg = String(log.msg ?? "");

      let levelColor = "\x1b[0m";
      if (log.level === 30 || log.level === "info") levelColor = "\x1b[32m";
      else if (log.level === 40 || log.level === "warn") levelColor = "\x1b[33m";
      else if (log.level === 50 || log.level === "error") levelColor = "\x1b[31m";
      else if (log.level === 20 || log.level === "debug") levelColor = "\x1b[36m";

      console.log(`\x1b[90m${time}\x1b[0m ${levelColor}${level}\x1b[0m ${module} ${msg}`);

      const extraKeys = Object.keys(log).filter((k) => !["time", "level", "module", "msg", "name", "pid", "hostname"].includes(k));
      if (extraKeys.length > 0) {
        const extra: Record<string, unknown> = {};
        for (const k of extraKeys) extra[k] = log[k];
        console.log(`  \x1b[90m${JSON.stringify(extra)}\x1b[0m`);
      }
    } else {
      console.log(line);
    }
  } catch {
    console.log(line);
  }
}

program.parse();
