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
      const chinaProviders = ["deepseek", "doubao", "zhipu", "dashscope", "kimi", "stepfun", "minimax", "modelscope"] as const;
      for (const id of chinaProviders) {
        const providerConfig = config.providers[id];
        const status = providerConfig?.apiKey ? "Configured" : "Not configured";
        console.log(`   ${id}: ${status}`);
      }

      // Check custom and overseas providers
      const extraProviders = ["openai", "openrouter", "together", "groq", "ollama", "vllm"] as const;
      for (const id of extraProviders) {
        const providerConfig = config.providers[id];
        if (providerConfig) {
          const status = (providerConfig as any).apiKey || id === "ollama" || id === "vllm" ? "Configured" : "Not configured";
          console.log(`   ${id}: ${status}`);
        }
      }
      if (config.providers["custom-openai"]) {
        const c = config.providers["custom-openai"] as Record<string, unknown>;
        const modelCount = Array.isArray(c.models) ? c.models.length : 0;
        console.log(`   custom-openai: Configured (${c.baseUrl}, ${modelCount} models)`);
      }
      if (config.providers["custom-anthropic"]) {
        const c = config.providers["custom-anthropic"] as Record<string, unknown>;
        const modelCount = Array.isArray(c.models) ? c.models.length : 0;
        console.log(`   custom-anthropic: Configured (${c.baseUrl}, ${modelCount} models)`);
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
    const readline = await import("readline");
    const fs = await import("fs");
    const path = await import("path");
    const os = await import("os");

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const question = (prompt: string): Promise<string> => {
      return new Promise((resolve) => {
        rl.question(prompt, resolve);
      });
    };

    console.log(`
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║   Welcome to the Vex Configuration Wizard                                ║
║                                                            ║
║   AI assistant supporting Chinese LLMs and comm platforms                       ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
`);

    // Configuration object (for config.local.json5)
    const config: {
      providers: Record<string, unknown>;
      channels: Record<string, unknown>;
      agent: Record<string, unknown>;
      server: Record<string, unknown>;
      memory: Record<string, unknown>;
    } = {
      providers: {},
      channels: {},
      agent: {},
      server: {},
      memory: {},
    };

    let defaultProvider = "";
    let defaultModel = "";

    // Step 1: Choose provider type
    console.log("\n[Step 1/5] Choose Provider Type\n");
    console.log("  1. Chinese Models (DeepSeek, Doubao, Zhipu AI, DashScope, Kimi, StepFun, MiniMax, ModelScope)");
    console.log("  2. Custom OpenAI-compatible (supports any OpenAI API format)");
    console.log("  3. Custom Anthropic-compatible (supports any Claude API format)");
    console.log("");

    const providerType = await question("Choose (1/2/3, comma-separated for multiple, e.g. 1,2): ");
    const selectedTypes = providerType.split(",").map((s) => s.trim());

    // Chinese model configuration
    if (selectedTypes.includes("1")) {
      console.log("\n--- Chinese Model Configuration ---\n");
      console.log("(Configure at least one, press Enter to skip)\n");

      const deepseekKey = await question("DeepSeek API Key: ");
      if (deepseekKey.trim()) {
        config.providers["deepseek"] = { apiKey: deepseekKey.trim() };
        if (!defaultProvider) {
          defaultProvider = "deepseek";
          defaultModel = "deepseek-chat";
        }
      }

      const doubaoKey = await question("Doubao API Key (Volcano Engine ARK, deep thinking models): ");
      if (doubaoKey.trim()) {
        config.providers["doubao"] = { apiKey: doubaoKey.trim() };
        if (!defaultProvider) {
          defaultProvider = "doubao";
          defaultModel = "doubao-seed-1-8-251228";
        }
      }

      const zhipuKey = await question("Zhipu AI API Key (GLM series, free quota available): ");
      if (zhipuKey.trim()) {
        config.providers["zhipu"] = { apiKey: zhipuKey.trim() };
        if (!defaultProvider) {
          defaultProvider = "zhipu";
          defaultModel = "glm-z1-flash";
        }
      }

      const dashscopeKey = await question("DashScope API Key (Alibaba Cloud, Qwen series): ");
      if (dashscopeKey.trim()) {
        config.providers["dashscope"] = { apiKey: dashscopeKey.trim() };
        if (!defaultProvider) {
          defaultProvider = "dashscope";
          defaultModel = "qwen3-235b-a22b";
        }
      }

      const kimiKey = await question("Kimi (Moonshot) API Key: ");
      if (kimiKey.trim()) {
        config.providers["kimi"] = { apiKey: kimiKey.trim() };
        if (!defaultProvider) {
          defaultProvider = "kimi";
          defaultModel = "kimi-k2.5";
        }
      }

      const stepfunKey = await question("StepFun API Key: ");
      if (stepfunKey.trim()) {
        config.providers["stepfun"] = { apiKey: stepfunKey.trim() };
        if (!defaultProvider) {
          defaultProvider = "stepfun";
          defaultModel = "step-2-mini";
        }
      }

      const minimaxKey = await question("MiniMax API Key: ");
      if (minimaxKey.trim()) {
        const minimaxGroup = await question("MiniMax Group ID: ");
        config.providers["minimax"] = {
          apiKey: minimaxKey.trim(),
          groupId: minimaxGroup.trim() || undefined,
        };
        if (!defaultProvider) {
          defaultProvider = "minimax";
          defaultModel = "MiniMax-M2.1";
        }
      }

      const modelscopeKey = await question("ModelScope API Key (Alibaba ModelScope, free quota available): ");
      if (modelscopeKey.trim()) {
        config.providers["modelscope"] = { apiKey: modelscopeKey.trim() };
        if (!defaultProvider) {
          defaultProvider = "modelscope";
          defaultModel = "Qwen/Qwen2.5-72B-Instruct";
        }
      }
    }

    // Custom OpenAI-compatible interface
    if (selectedTypes.includes("2")) {
      console.log("\n--- Custom OpenAI-Compatible Interface ---\n");
      console.log("Suitable for: OpenAI, Azure OpenAI, vLLM, Ollama, other OpenAI-compatible services\n");

      const customOpenaiBaseUrl = await question("API Endpoint (e.g. https://api.openai.com/v1): ");
      if (customOpenaiBaseUrl.trim()) {
        const customOpenaiKey = await question("API Key: ");
        const customOpenaiName = await question("Provider name (e.g. OpenAI, vLLM): ");

        console.log("\nConfigure model list (add at least one model):");
        const models: Array<{
          id: string;
          name?: string;
          contextWindow?: number;
          maxTokens?: number;
          supportsVision?: boolean;
        }> = [];

        let addMore = true;
        while (addMore) {
          const modelId = await question("\nModel ID (e.g. gpt-4o, gpt-3.5-turbo): ");
          if (!modelId.trim()) {
            if (models.length === 0) {
              console.log("⚠️  At least one model required");
              continue;
            }
            break;
          }

          const modelName = await question("Model display name (optional, Enter to use ID): ");
          const contextWindow = await question("Context window size (default 128000): ");
          const maxTokens = await question("Max output tokens (default 4096): ");
          const supportsVision = await question("Supports vision/images? (y/n, default n): ");

          models.push({
            id: modelId.trim(),
            name: modelName.trim() || undefined,
            contextWindow: contextWindow.trim() ? parseInt(contextWindow.trim(), 10) : undefined,
            maxTokens: maxTokens.trim() ? parseInt(maxTokens.trim(), 10) : undefined,
            supportsVision: supportsVision.toLowerCase() === "y" ? true : undefined,
          });

          console.log(`✓ Model added: ${modelId.trim()}`);
          const continueAdd = await question("Add another model? (y/n): ");
          addMore = continueAdd.toLowerCase() === "y";
        }

        if (models.length > 0) {
          config.providers["custom-openai"] = {
            id: "custom-openai",
            name: customOpenaiName.trim() || "Custom OpenAI",
            baseUrl: customOpenaiBaseUrl.trim(),
            apiKey: customOpenaiKey.trim(),
            models: models,
          };

          if (!defaultProvider && models[0]) {
            defaultProvider = "custom-openai";
            defaultModel = models[0].id;
          }
        }
      }
    }

    // Custom Anthropic-compatible interface
    if (selectedTypes.includes("3")) {
      console.log("\n--- Custom Anthropic-Compatible Interface ---\n");
      console.log("Suitable for: Anthropic Claude, AWS Bedrock Claude, other Claude API-compatible services\n");

      const customAnthropicBaseUrl = await question("API Endpoint (e.g. https://api.anthropic.com/v1): ");
      if (customAnthropicBaseUrl.trim()) {
        const customAnthropicKey = await question("API Key: ");
        const customAnthropicName = await question("Provider name (e.g. Anthropic, Bedrock): ");
        const apiVersion = await question("API version (default 2023-06-01): ");

        console.log("\nConfigure model list (add at least one model):");
        const models: Array<{
          id: string;
          name?: string;
          contextWindow?: number;
          maxTokens?: number;
          supportsVision?: boolean;
        }> = [];

        let addMore = true;
        while (addMore) {
          const modelId = await question("\nModel ID (e.g. claude-3-5-sonnet-20241022): ");
          if (!modelId.trim()) {
            if (models.length === 0) {
              console.log("⚠️  At least one model required");
              continue;
            }
            break;
          }

          const modelName = await question("Model display name (optional, Enter to use ID): ");
          const contextWindow = await question("Context window size (default 200000): ");
          const maxTokens = await question("Max output tokens (default 8192): ");
          const supportsVision = await question("Supports vision/images? (y/n, default n): ");

          models.push({
            id: modelId.trim(),
            name: modelName.trim() || undefined,
            contextWindow: contextWindow.trim() ? parseInt(contextWindow.trim(), 10) : undefined,
            maxTokens: maxTokens.trim() ? parseInt(maxTokens.trim(), 10) : undefined,
            supportsVision: supportsVision.toLowerCase() === "y" ? true : undefined,
          });

          console.log(`✓ Model added: ${modelId.trim()}`);
          const continueAdd = await question("Add another model? (y/n): ");
          addMore = continueAdd.toLowerCase() === "y";
        }

        if (models.length > 0) {
          config.providers["custom-anthropic"] = {
            id: "custom-anthropic",
            name: customAnthropicName.trim() || "Custom Anthropic",
            baseUrl: customAnthropicBaseUrl.trim(),
            apiKey: customAnthropicKey.trim(),
            apiVersion: apiVersion.trim() || "2023-06-01",
            models: models,
          };

          if (!defaultProvider && models[0]) {
            defaultProvider = "custom-anthropic";
            defaultModel = models[0].id;
          }
        }
      }
    }

    // Step 2: Channel configuration
    console.log("\n[Step 2/5] Configure Communication Platform\n");
    console.log("Supported platforms: Personal WeChat");
    console.log("(Optional, press Enter to skip)\n");

    // Personal WeChat uses QR code login, no manual credentials needed
    const configWeixin = await question("Enable Personal WeChat? (y/n): ");
    if (configWeixin.toLowerCase() === "y") {
      config.channels["weixin"] = { enabled: true };
      console.log("   Personal WeChat enabled. QR code will be displayed on first start for login.\n");
    }

    // Step 3: Server configuration
    console.log("\n[Step 3/5] Configure Server\n");

    const port = await question("Server port (default 3000): ");
    config.server = {
      port: parseInt(port.trim(), 10) || 3000,
    };

    // Step 4: Agent configuration
    console.log("\n[Step 4/5] Configure Agent\n");

    if (defaultProvider && defaultModel) {
      console.log(`Detected default model: ${defaultProvider} / ${defaultModel}`);
      const changeDefault = await question("Change default model? (y/n): ");
      if (changeDefault.toLowerCase() === "y") {
        const newProvider = await question(`Default provider (current: ${defaultProvider}): `);
        const newModel = await question(`Default model (current: ${defaultModel}): `);
        if (newProvider.trim()) defaultProvider = newProvider.trim();
        if (newModel.trim()) defaultModel = newModel.trim();
      }
    } else {
      defaultProvider = await question("Default provider: ");
      defaultModel = await question("Default model: ");
    }

    if (defaultProvider && defaultModel) {
      config.agent = {
        defaultProvider,
        defaultModel,
      };
    }

    // Step 5: Memory system configuration
    console.log("\n[Step 5/5] Configure Memory System\n");
    console.log("Memory system allows Agent to remember info across sessions (preferences, facts, etc.)");
    console.log("Memory is enabled by default, stored in ~/.vex/memory/\n");

    const configMemory = await question("Customize memory system config? (y/n, default n): ");
    if (configMemory.toLowerCase() === "y") {
      const memoryEnabled = await question("Enable memory system? (y/n, default y): ");
      const isEnabled = memoryEnabled.toLowerCase() !== "n";

      if (isEnabled) {
        const storageDir = await question("Memory storage directory (default ~/.vex/memory): ");
        config.memory = {
          enabled: true,
          storageDir: storageDir.trim() || undefined,
        };
      } else {
        config.memory = {
          enabled: false,
        };
      }
    }

    // Write config file
    console.log("\n");

    const hasProviders = Object.keys(config.providers).length > 0;
    if (!hasProviders) {
      console.log("⚠️  No model provider configured. Please configure at least one.\n");
      rl.close();
      return;
    }

    // Clean up empty objects
    if (Object.keys(config.channels).length === 0) delete (config as Record<string, unknown>).channels;
    if (Object.keys(config.agent).length === 0) delete (config as Record<string, unknown>).agent;
    if (Object.keys(config.memory).length === 0) delete (config as Record<string, unknown>).memory;

    // Generate JSON5 format config
    const configContent = generateJson5(config);

    // Config file path
    const vexDir = path.join(os.homedir(), ".vex");
    const configPath = path.join(vexDir, "config.local.json5");

    console.log("Generated configuration:\n");
    console.log("---");
    console.log(configContent);
    console.log("---\n");

    const writeConfig = await question(`Write config to ${configPath}? (y/n): `);
    if (writeConfig.toLowerCase() === "y") {
      // Ensure directory exists
      if (!fs.existsSync(vexDir)) {
        fs.mkdirSync(vexDir, { recursive: true });
      }
      fs.writeFileSync(configPath, configContent);
      console.log(`\nConfiguration saved to ${configPath}`);
    } else {
      console.log("\nPlease save the above configuration to your config file manually.");
    }

    const hasChannels = Object.keys(config.channels || {}).length > 0;
    const startCmd = hasChannels ? "vex start" : "vex start --web-only";
    const startNote = hasChannels
      ? "   (Communication platform configured, will start together)"
      : "   (WebChat only, configure channels for communication platforms)";

    console.log(`
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║   Configuration complete!                                             ║
║                                                            ║
║   Next steps:                                                  ║
║                                                            ║
║   1. Check configuration: vex check                                  ║
║   2. Start service: ${startCmd.padEnd(26)}║
${startNote.padEnd(61)}║
║   3. Test chat: vex chat                                   ║
║                                                            ║
║   Startup options:                                                ║
║   - vex start           Full service (WebChat+Personal WeChat)        ║
║   - vex start --web-only WebChat only                       ║
║                                                            ║
║   Config file: ~/.vex/config.local.json5                     ║
║   Docs: https://github.com/King-Chau/vex                  ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
`);

    rl.close();
  });

/** Generate JSON5 format config string */
function generateJson5(obj: unknown, indent = 0): string {
  const spaces = "  ".repeat(indent);
  const innerSpaces = "  ".repeat(indent + 1);

  if (obj === null || obj === undefined) {
    return "null";
  }

  if (typeof obj === "string") {
    return `"${obj.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }

  if (typeof obj === "number" || typeof obj === "boolean") {
    return String(obj);
  }

  if (Array.isArray(obj)) {
    if (obj.length === 0) return "[]";
    const items = obj.map((item) => `${innerSpaces}${generateJson5(item, indent + 1)}`);
    return `[\n${items.join(",\n")}\n${spaces}]`;
  }

  if (typeof obj === "object") {
    const entries = Object.entries(obj).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return "{}";

    const items = entries.map(([key, value]) => {
      // Use unquoted key (if valid ECMAScript identifier)
      const safeKey = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) ? key : `"${key}"`;
      return `${innerSpaces}${safeKey}: ${generateJson5(value, indent + 1)}`;
    });

    return `{\n${items.join(",\n")}\n${spaces}}`;
  }

  return String(obj);
}

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
