import { afterEach, describe, expect, it, vi } from "vitest";
import { createBuiltinTools, createWeatherTool } from "../src/tools/builtin/index.js";

function textFromResult(result: Awaited<ReturnType<ReturnType<typeof createWeatherTool>["execute"]>>): string {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("Expected text result");
  return first.text;
}

function jsonFromResult(result: Awaited<ReturnType<ReturnType<typeof createWeatherTool>["execute"]>>): Record<string, unknown> {
  return JSON.parse(textFromResult(result)) as Record<string, unknown>;
}

function mockJsonFetch(payload: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("weather tool", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is registered with built-in tools", () => {
    const tools = createBuiltinTools({
      enableBrowser: false,
      enableFilesystem: false,
      enableBash: false,
      enableProcess: false,
    });

    expect(tools.some((tool) => tool.name === "weather")).toBe(true);
  });

  it("queries wttr and normalizes the response", async () => {
    const fetchMock = mockJsonFetch({
      current_condition: [{
        temp_C: "28",
        FeelsLikeC: "31",
        humidity: "76",
        windspeedKmph: "12",
        winddir16Point: "E",
        lang_zh: [{ value: "多云" }],
        observation_time: "09:00 AM",
      }],
      nearest_area: [{ areaName: [{ value: "Shenzhen" }] }],
      weather: [{
        date: "2026-07-02",
        maxtempC: "31",
        mintempC: "26",
        avgtempC: "28",
        sunHour: "9.0",
      }],
    });

    const tool = createWeatherTool({ config: { weather_provider: "wttr", cache_ttl_ms: 0 } });
    const result = await tool.execute("call-1", { location: "深圳" });
    const payload = jsonFromResult(result);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("wttr.in");
    expect(payload.provider).toBe("wttr");
    expect(payload.resolvedLocation).toBe("Shenzhen");
    expect(payload.current).toMatchObject({ description: "多云" });
  });

  it("queries Caiyun with configured token and city coordinates", async () => {
    const fetchMock = mockJsonFetch({
      status: "ok",
      result: {
        realtime: {
          temperature: 30.2,
          apparent_temperature: 34.1,
          humidity: 0.72,
          skycon: "PARTLY_CLOUDY_DAY",
          wind: { speed: 5.3, direction: 110 },
          air_quality: { aqi: { chn: 24 } },
        },
        daily: {
          temperature: [{ date: "2026-07-02T00:00+08:00", max: 32, min: 27, avg: 29 }],
          skycon: [{ date: "2026-07-02T00:00+08:00", value: "PARTLY_CLOUDY_DAY" }],
          precipitation: [{ date: "2026-07-02T00:00+08:00", avg: 0.2 }],
          life_index: { ultraviolet: [{ date: "2026-07-02T00:00+08:00", index: "3", desc: "弱" }] },
        },
      },
    });

    const tool = createWeatherTool({
      config: {
        weather_provider: "caiyun",
        caiyun_api_key: "token-123",
        caiyun_api_version: "v2.6",
        cache_ttl_ms: 0,
      },
    });
    const result = await tool.execute("call-2", { location: "深圳", days: 1 });
    const payload = jsonFromResult(result);

    expect(fetchMock).toHaveBeenCalledOnce();
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("https://api.caiyunapp.com/v2.6/token-123/");
    expect(url).toContain("114.0579,22.5431");
    expect(payload.provider).toBe("caiyun");
    expect(payload.current).toMatchObject({
      temperatureC: 30.2,
      skyconText: "多云（白天）",
    });
  });

  it("returns an error when Caiyun is selected without an API key", async () => {
    const tool = createWeatherTool({ config: { weather_provider: "caiyun", cache_ttl_ms: 0 } });
    const result = await tool.execute("call-3", { location: "深圳" });
    const payload = jsonFromResult(result);

    expect(result.isError).toBe(true);
    expect(payload.error).toContain("caiyun_api_key");
  });
});
