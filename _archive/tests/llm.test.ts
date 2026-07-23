/**
 * llmComplete 测试 —— 回归：一次性 LLM 调用必须把 provider 的 API key
 * 转发给 pi-ai 的 completeSimple，否则非环境变量类 provider（如 longcat）会
 * 抛 "No API key for provider"。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/utils/logger.js", () => ({
  getChildLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const completeSimpleMock = vi.fn();

// 保留 pi-ai 的真实导出（model-resolver 依赖它构建 Model），只替换 completeSimple。
vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-ai")>();
  return {
    ...actual,
    completeSimple: (...args: unknown[]) => completeSimpleMock(...args),
  };
});

import { initializeProviders } from "../src/providers/index.js";
import { llmComplete } from "../src/providers/llm.js";
import type { VexConfig } from "../src/types/index.js";

function makeConfig(providers: Record<string, any>): VexConfig {
  return {
    providers,
    channels: {},
    agent: { defaultModel: "test-model", defaultProvider: "deepseek" },
    server: { port: 3000 },
    logging: { level: "error" },
  } as VexConfig;
}

describe("llmComplete", () => {
  beforeEach(() => {
    completeSimpleMock.mockReset();
    completeSimpleMock.mockResolvedValue({
      content: [{ type: "text", text: "[]" }],
      usage: { input: 3, output: 1 },
    });
    initializeProviders(makeConfig({ longcat: { apiKey: "sk-longcat-key" } }));
  });

  it("forwards the resolved provider API key to completeSimple options", async () => {
    await llmComplete({ providerId: "longcat", model: "LongCat-2.0", prompt: "hi" });

    expect(completeSimpleMock).toHaveBeenCalledTimes(1);
    const options = completeSimpleMock.mock.calls[0]![2] as { apiKey?: string };
    expect(options.apiKey).toBe("sk-longcat-key");
  });

  it("returns extracted text from the assistant message", async () => {
    const result = await llmComplete({ providerId: "longcat", model: "LongCat-2.0", prompt: "hi" });
    expect(result.text).toBe("[]");
  });
});
