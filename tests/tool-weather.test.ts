/**
 * Weather tool tests — createWeatherTool.
 */

import { describe, it, expect } from "vitest";

describe("createWeatherTool", () => {
  let createWeatherTool: (options?: any) => any;

  beforeAll(async () => {
    ({ createWeatherTool } = await import(
      "../src/tools/builtin/weather.js"
    ));
  });

  it("has correct metadata", () => {
    const tool = createWeatherTool();
    expect(tool.name).toBe("weather");
    expect(tool.label).toBe("Weather");
    expect(tool.description).toContain("weather");
  });

  it("returns error when no location or coordinates provided", async () => {
    const tool = createWeatherTool();
    const result = await tool.execute("call-1", {});
    // Without location or lat/lng, it should return an error
    expect(result.isError).toBe(true);
    expect(result.details.error).toContain("location");
  });
});
