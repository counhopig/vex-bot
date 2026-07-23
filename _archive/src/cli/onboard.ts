import * as readline from "node:readline";
import { homedir } from "os";
import { join } from "path";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import yaml from "yaml";

/**
 * Run the interactive configuration wizard and write ~/.vex/config.local.yaml.
 *
 * Guides the user through 5 steps:
 *   1. Model provider setup (Chinese, custom OpenAI, custom Anthropic)
 *   2. Communication platform configuration
 *   3. Server configuration
 *   4. Agent configuration
 *   5. Memory system configuration
 */
export async function runOnboardWizard(): Promise<void> {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	const question = (prompt: string): Promise<string> => {
		const { promise, resolve } = Promise.withResolvers<string>();
		rl.question(prompt, resolve);
		return promise;
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
	console.log("  1. Chinese Models (DeepSeek, Doubao, Zhipu AI, LongCat, DashScope, Kimi, StepFun, MiniMax, ModelScope)");
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

		const longcatKey = await question("LongCat API Key: ");
		if (longcatKey.trim()) {
			config.providers["longcat"] = { apiKey: longcatKey.trim() };
			if (!defaultProvider) {
				defaultProvider = "longcat";
				defaultModel = "LongCat-2.0";
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

	const configContent = yaml.stringify(config);

	// Config file path
	const vexDir = join(homedir(), ".vex");
	const configPath = join(vexDir, "config.local.yaml");

	console.log("Generated configuration:\n");
	console.log("---");
	console.log(configContent);
	console.log("---\n");

	const writeConfig = await question(`Write config to ${configPath}? (y/n): `);
	if (writeConfig.toLowerCase() === "y") {
		// Ensure directory exists
		if (!existsSync(vexDir)) {
			mkdirSync(vexDir, { recursive: true });
		}
		writeFileSync(configPath, configContent);
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
║   Config file: ~/.vex/config.local.yaml                      ║
║   Docs: https://github.com/King-Chau/vex                  ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
`);

	rl.close();
}
