/**
 * CLI `chat` command — bare model connectivity test.
 *
 * Deliberately bypasses Agent/Persona/Tools: this is an operator diagnostic
 * that dials the configured LLM directly (tools: []). Preserved from the
 * archive verbatim — it is NOT a CliChannel (rewrite-plan: the architecture
 * diagram's "CLI channel" has no implementation; making one is new work, not
 * a migration).
 */

import { ModelResolver } from "../providers/ModelResolver.js";
import type { SystemConfig } from "../web/routes/config.js";
import type { Context } from "@mariozechner/pi-ai";

export interface ChatOptions {
  model?: string;
  provider?: string;
}

/** Run the interactive chat test against the configured provider. */
export async function runChat(config: SystemConfig, options?: ChatOptions): Promise<void> {
  const resolver = new ModelResolver();
  resolver.init({ providers: (config.providers ?? {}) as Record<string, { baseUrl?: string; apiKey?: string; headers?: Record<string, string> } | undefined> });

  const readline = await import("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const agent = (config.agent ?? {}) as Record<string, unknown>;
  const model = options?.model ?? (typeof agent.defaultModel === "string" ? agent.defaultModel : "deepseek-chat");
  const provider = options?.provider ?? (typeof agent.defaultProvider === "string" ? agent.defaultProvider : "deepseek");

  console.log(`\nVex Chat Test`);
  console.log(`   Model: ${model}`);
  console.log(`   Provider: ${provider}`);
  console.log(`   Type 'exit' to quit\n`);

  const { streamSimple } = await import("@mariozechner/pi-ai");
  const piModel = resolver.resolveModel(provider, model);

  if (!piModel) {
    console.error(`Model not found: ${model}  provider`);
    process.exit(1);
  }

  const apiKey = resolver.getApiKeyForProvider(provider);
  const temperature = typeof agent.temperature === "number" ? agent.temperature : 0.7;
  const maxTokens = typeof agent.maxTokens === "number" ? agent.maxTokens : 4096;

  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];

  const ask = (): void => {
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

        const piMessages: Context["messages"] = messages.map((m): Context["messages"][number] => {
          if (m.role === "user") {
            return { role: "user" as const, content: m.content, timestamp: Date.now() };
          }
          return {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: m.content }],
            timestamp: Date.now(),
            api: "openai-completions" as const,
            provider,
            model,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "stop" as const,
          } as Context["messages"][number];
        });

        const eventStream = streamSimple(piModel, { messages: piMessages, tools: [] }, { temperature, maxTokens, apiKey });

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
}
