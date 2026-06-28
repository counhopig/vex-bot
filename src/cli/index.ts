#!/usr/bin/env node

// Node.js v24+ undici strictly validates ByteString headers, but some API
// providers (e.g. MiniMax) return non-ASCII characters in response headers.
// Patch global fetch to sanitize response headers before they reach undici's
// header parser.
import "./fetch-patch.js";

/**
 * Vex CLI - Command Line Interface
 */

import { Command } from "commander";
import type { Message } from "@mariozechner/pi-ai";
import { loadConfig, validateRequiredConfig } from "../config/index.js";
import { startGateway } from "../gateway/server.js";
import { initializeProviders, getAllModels, resolveModel, getApiKeyForProvider } from "../providers/index.js";
import { createLogger, setLogger, getLogDir, getLogFile } from "../utils/logger.js";
import { CHINA_PROVIDER_IDS, OVERSEAS_PROVIDER_IDS, getProviderMeta } from "../providers/metadata.js";
import { runOnboardWizard } from "./onboard.js";
import dotenv from "dotenv";
import { spawn } from "child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// Load environment variables
dotenv.config();

// Read version from package.json
const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = join(__dirname, "..", "..", "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));

const program = new Command();

program
  .name("vex")
  .description("Vex - AI assistant supporting Chinese LLMs and communication platforms")
  .version(packageJson.version);

// Start command
program
  .command("start")
  .description("Start Gateway server")
  .option("-c, --config <path>", "Config file path")
  .option("-p, --port <port>", "Server port")
  .option("--web-only", "WebChat only (no channel configuration required)")
  .action(async (options) => {
    try {
      const config = loadConfig({ configPath: options.config });

      // Override port
      if (options.port) {
        config.server.port = parseInt(options.port, 10);
      }

      // Validate configuration
      const errors = validateRequiredConfig(config, { webOnly: options.webOnly });
      if (errors.length > 0) {
        console.error("ERROR: Configuration error:");
        errors.forEach((err) => console.error(`   - ${err}`));
        process.exit(1);
      }

      await startGateway(config);
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
      setLogger(createLogger({ level: "error" })); // Silence logs
      initializeProviders(config);

      const models = getAllModels();

      if (models.length === 0) {
        console.log("No model providers configured. Please check API Key configuration.");
        return;
      }

      console.log("\nAvailable models:\n");

      // Group by provider
      const byProvider = new Map<string, typeof models>();
      for (const item of models) {
        const list = byProvider.get(item.provider) || [];
        list.push(item);
        byProvider.set(item.provider, list);
      }

      for (const [provider, list] of byProvider) {
        console.log(`📦 ${provider.toUpperCase()}`);
        for (const item of list) {
          const vision = item.model.supportsVision ? " 👁️" : "";
          const reasoning = item.model.supportsReasoning ? " 🧠" : "";
          console.log(`   - ${item.model.id} (${item.model.name})${vision}${reasoning}`);
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
      console.log("Checking configuration...\n");

      const config = loadConfig({ configPath: options.config });

      // Check providers
      console.log("Model providers:");
      for (const id of CHINA_PROVIDER_IDS) {
        const providerConfig = config.providers[id];
        const status = providerConfig?.apiKey ? "Configured" : "Not configured";
        console.log(`   ${id}: ${status}`);
      }

      // Overseas / local providers
      for (const id of OVERSEAS_PROVIDER_IDS) {
        const providerConfig = config.providers[id];
        if (providerConfig) {
          const meta = getProviderMeta(id);
          const status = providerConfig.apiKey || meta?.requiresApiKey === false ? "Configured" : "Not configured";
          console.log(`   ${id}: ${status}`);
        }
      }
      for (const id of ["custom-openai", "custom-anthropic"] as const) {
        const c = config.providers[id] as Record<string, unknown> | undefined;
        if (c) {
          const modelCount = Array.isArray(c.models) ? c.models.length : 0;
          const baseUrl = typeof c.baseUrl === "string" ? c.baseUrl : "";
          console.log(`   ${id}: Configured (${baseUrl}, ${modelCount} models)`);
        }
      }

      // Check channels
      console.log("\nCommunication channels:");
      const channels = [
        { id: "weixin", name: "Personal WeChat", config: config.channels.weixin },
      ];
      for (const channel of channels) {
        const status = channel.config ? "Configured" : "Not configured";
        console.log(`   ${channel.name}: ${status}`);
      }

      // Check Agent
      console.log("\nAgent configuration:");
      console.log(`   Default model: ${config.agent.defaultModel}`);
      console.log(`   Default provider: ${config.agent.defaultProvider}`);
      console.log(`   Temperature: ${config.agent.temperature}`);
      console.log(`   Max tokens: ${config.agent.maxTokens}`);

      // Check server
      console.log("\nServer configuration:");
      console.log(`   Port: ${config.server.port}`);
      console.log(`   Host: ${config.server.host || "0.0.0.0"}`);

      // Validation
      const errors = validateRequiredConfig(config);
      if (errors.length > 0) {
        console.log("\nConfiguration issues:");
        errors.forEach((err) => console.log(`   - ${err}`));
      } else {
        console.log("\nConfiguration check passed!");
      }
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
      setLogger(createLogger({ level: "error" }));
      initializeProviders(config);

      const readline = await import("readline");
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const model = options.model || config.agent.defaultModel;
      const provider = options.provider || config.agent.defaultProvider;

      console.log(`\nVex Chat Test`);
      console.log(`   Model: ${model}`);
      console.log(`   Provider: ${provider}`);
      console.log(`   Type 'exit' to quit\n`);

      const { streamSimple } = await import("@mariozechner/pi-ai");
      const piModel = resolveModel(provider, model);

      if (!piModel) {
        console.error(`Model not found: ${model}  provider`);
        process.exit(1);
      }

      const apiKey = getApiKeyForProvider(provider);

      const messages: Array<{ role: "user" | "assistant"; content: string }> = [];

      const ask = () => {
        rl.question("You: ", async (input) => {
          if (input.toLowerCase() === "exit") {
            console.log("Goodbye!");
            rl.close();
            return;
          }

          messages.push({ role: "user", content: input });

          try {
            process.stdout.write("AI: ");
            let fullResponse = "";

            const piMessages: Message[] = messages.map((m): Message => {
              if (m.role === "user") {
                return { role: "user" as const, content: m.content, timestamp: Date.now() };
              }
              return {
                role: "assistant" as const,
                content: [{ type: "text" as const, text: m.content }],
                timestamp: Date.now(),
                api: "openai-completions" as const,
                provider: provider,
                model: model,
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
                stopReason: "stop" as const,
              };
            });

            const eventStream = streamSimple(piModel, {
              messages: piMessages,
              tools: [],
            }, {
              temperature: config.agent.temperature,
              maxTokens: config.agent.maxTokens,
              apiKey,
            });

            for await (const event of eventStream) {
              if (event.type === "text_delta") {
                process.stdout.write(event.delta);
                fullResponse += event.delta;
              }
            }

            console.log("\n");
            messages.push({ role: "assistant", content: fullResponse });
          } catch (error) {
            console.error("\nError:", error instanceof Error ? error.message : error);
          }

          ask();
        });
      };

      ask();
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
    const { execSync } = await import("child_process");

    try {
      // Find vex processes
      const result = execSync('pgrep -f "node.*dist/cli.*start" 2>/dev/null || echo ""', { encoding: "utf-8" });
      const pids = result.trim().split("\n").filter(Boolean);

      if (pids.length === 0) {
        console.log("No running Vex service found");
        return;
      }

      console.log(`Found ${pids.length} Vex process(es): ${pids.join(", ")}`);

      // Kill processes
      for (const pid of pids) {
        try {
          process.kill(parseInt(pid, 10), "SIGTERM");
          console.log(`Termination signal sent to process ${pid}`);
        } catch (err) {
          console.error(`Cannot terminate process ${pid}:`, err instanceof Error ? err.message : err);
        }
      }

      // Wait for process exit
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Check if any processes still running
      const remaining = execSync('pgrep -f "node.*dist/cli.*start" 2>/dev/null || echo ""', { encoding: "utf-8" }).trim();
      if (remaining) {
        console.log("Some processes still running, attempting force kill...");
        execSync(`pkill -9 -f "node.*dist/cli.*start" 2>/dev/null || true`);
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
  .description("Restart Vex service")
  .option("-c, --config <path>", "Config file path")
  .option("-p, --port <port>", "Server port")
  .option("--web-only", "WebChat only")
  .action(async (options) => {
    const { execSync, spawn: spawnProcess } = await import("child_process");

    console.log("Restarting Vex service...\n");

    // 1. Stop existing service
    try {
      const result = execSync('pgrep -f "node.*dist/cli.*start" 2>/dev/null || echo ""', { encoding: "utf-8" });
      const pids = result.trim().split("\n").filter(Boolean);

      if (pids.length > 0) {
        console.log(`Stopping existing service (PID: ${pids.join(", ")})...`);
        execSync(`pkill -f "node.*dist/cli.*start" 2>/dev/null || true`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    } catch {
      // Ignore errors
    }

    // 2. Start new service
    console.log("Starting new service...\n");

    const args = ["start"];
    if (options.config) args.push("-c", options.config);
    if (options.port) args.push("-p", options.port);
    if (options.webOnly) args.push("--web-only");

    // Start directly with current process (not background)
    try {
      const config = loadConfig({ configPath: options.config });

      if (options.port) {
        config.server.port = parseInt(options.port, 10);
      }

      const errors = validateRequiredConfig(config, { webOnly: options.webOnly });
      if (errors.length > 0) {
        console.error("ERROR: Configuration error:");
        errors.forEach((err) => console.error(`   - ${err}`));
        process.exit(1);
      }

      await startGateway(config);
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
    const { execSync } = await import("child_process");

    console.log("\nVex Service Status\n");

    try {
      // Find vex processes
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

      // Check health status
      try {
        const config = loadConfig();
        const port = config.server?.port || 3000;
        const health = execSync(`curl -s http://localhost:${port}/health 2>/dev/null || echo ""`, { encoding: "utf-8" }).trim();

        if (health) {
          const healthData = JSON.parse(health);
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
    const logDir = getLogDir();

    // List all log files
    if (options.list) {
      console.log(`\nLog directory: ${logDir}\n`);

      if (!existsSync(logDir)) {
        console.log("No log files found");
        return;
      }

      const files = readdirSync(logDir)
        .filter((f) => f.endsWith(".log"))
        .sort()
        .reverse();

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

    // Determine which log file to view
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

    // Follow mode
    if (options.follow) {
      console.log("Following logs... (Ctrl+C to exit)\n");

      const args = ["-f", logFile];
      if (options.lines) {
        args.unshift("-n", options.lines);
      }

      const tail = spawn("tail", args, { stdio: "pipe" });

      tail.stdout.on("data", (data: Buffer) => {
        const lines = data.toString().split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          printLogLine(line, options.level, options.pretty);
        }
      });

      tail.stderr.on("data", (data: Buffer) => {
        console.error(data.toString());
      });

      process.on("SIGINT", () => {
        tail.kill();
        process.exit(0);
      });

      return;
    }

    // Show last N lines
    const content = readFileSync(logFile, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());
    const lastN = parseInt(options.lines, 10) || 50;
    const displayLines = lines.slice(-lastN);

    for (const line of displayLines) {
      printLogLine(line, options.level, options.pretty);
    }

    console.log(`\nShowing last ${displayLines.length} log entries`);
    console.log(`Tip: Use 'vex logs -f' to follow logs in real time`);
  });

/** Print log line */
function printLogLine(line: string, levelFilter?: string, pretty?: boolean): void {
  try {
    const log = JSON.parse(line);

    // Level filter
    if (levelFilter) {
      const levelOrder = ["debug", "info", "warn", "error"];
      const logLevel = levelOrder.indexOf(log.level?.toString() || "info");
      const filterLevel = levelOrder.indexOf(levelFilter);
      if (logLevel < filterLevel) return;
    }

    if (pretty) {
      // Pretty output
      const time = log.time ? new Date(log.time).toLocaleString() : "";
      const level = (log.level || "INFO").toString().toUpperCase().padEnd(5);
      const module = log.module ? `[${log.module}]` : "";
      const msg = log.msg || "";

      // Colors
      let levelColor = "\x1b[0m"; // reset
      if (log.level === 30 || log.level === "info") levelColor = "\x1b[32m"; // green
      else if (log.level === 40 || log.level === "warn") levelColor = "\x1b[33m"; // yellow
      else if (log.level === 50 || log.level === "error") levelColor = "\x1b[31m"; // red
      else if (log.level === 20 || log.level === "debug") levelColor = "\x1b[36m"; // cyan

      console.log(`\x1b[90m${time}\x1b[0m ${levelColor}${level}\x1b[0m ${module} ${msg}`);

      // Show extra fields
      const extraKeys = Object.keys(log).filter(
        (k) => !["time", "level", "module", "msg", "name", "pid", "hostname"].includes(k)
      );
      if (extraKeys.length > 0) {
        const extra: Record<string, unknown> = {};
        for (const k of extraKeys) extra[k] = log[k];
        console.log(`  \x1b[90m${JSON.stringify(extra)}\x1b[0m`);
      }
    } else {
      console.log(line);
    }
  } catch {
    // Non-JSON format, output directly
    console.log(line);
  }
}

program.parse();
