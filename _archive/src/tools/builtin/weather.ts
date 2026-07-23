import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { errorResult, jsonResult, readNumberParam, readStringParam } from "../common.js";
import type { WeatherConfig } from "../../types/index.js";

type WeatherProvider = "wttr" | "caiyun";

export interface WeatherToolOptions {
  config?: WeatherConfig;
}

interface Coordinates {
  latitude: number;
  longitude: number;
}

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;

const CITY_COORDINATES: Record<string, Coordinates> = {
  北京: { latitude: 39.9042, longitude: 116.4074 },
  上海: { latitude: 31.2304, longitude: 121.4737 },
  广州: { latitude: 23.1291, longitude: 113.2644 },
  深圳: { latitude: 22.5431, longitude: 114.0579 },
  香港: { latitude: 22.3193, longitude: 114.1694 },
  澳门: { latitude: 22.1987, longitude: 113.5439 },
  杭州: { latitude: 30.2741, longitude: 120.1551 },
  南京: { latitude: 32.0603, longitude: 118.7969 },
  成都: { latitude: 30.5728, longitude: 104.0668 },
  重庆: { latitude: 29.563, longitude: 106.5516 },
  武汉: { latitude: 30.5928, longitude: 114.3055 },
  西安: { latitude: 34.3416, longitude: 108.9398 },
  天津: { latitude: 39.3434, longitude: 117.3616 },
  苏州: { latitude: 31.2989, longitude: 120.5853 },
  青岛: { latitude: 36.0671, longitude: 120.3826 },
  厦门: { latitude: 24.4798, longitude: 118.0894 },
  台北: { latitude: 25.033, longitude: 121.5654 },
  臺北: { latitude: 25.033, longitude: 121.5654 },
  Taipei: { latitude: 25.033, longitude: 121.5654 },
  东京: { latitude: 35.6762, longitude: 139.6503 },
  Tokyo: { latitude: 35.6762, longitude: 139.6503 },
  伦敦: { latitude: 51.5072, longitude: -0.1276 },
  London: { latitude: 51.5072, longitude: -0.1276 },
  纽约: { latitude: 40.7128, longitude: -74.006 },
  "New York": { latitude: 40.7128, longitude: -74.006 },
  旧金山: { latitude: 37.7749, longitude: -122.4194 },
  "San Francisco": { latitude: 37.7749, longitude: -122.4194 },
};

const SKYCON_ZH: Record<string, string> = {
  CLEAR_DAY: "晴（白天）",
  CLEAR_NIGHT: "晴（夜间）",
  PARTLY_CLOUDY_DAY: "多云（白天）",
  PARTLY_CLOUDY_NIGHT: "多云（夜间）",
  CLOUDY: "阴",
  LIGHT_HAZE: "轻度雾霾",
  MODERATE_HAZE: "中度雾霾",
  HEAVY_HAZE: "重度雾霾",
  LIGHT_RAIN: "小雨",
  MODERATE_RAIN: "中雨",
  HEAVY_RAIN: "大雨",
  STORM_RAIN: "暴雨",
  FOG: "雾",
  LIGHT_SNOW: "小雪",
  MODERATE_SNOW: "中雪",
  HEAVY_SNOW: "大雪",
  STORM_SNOW: "暴雪",
  DUST: "浮尘",
  SAND: "沙尘",
  WIND: "大风",
};

const cache = new Map<string, { expiresAt: number; payload: unknown }>();

function readCache(key: string): unknown | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return entry.payload;
}

function writeCache(key: string, payload: unknown, ttlMs: number): void {
  if (ttlMs <= 0) return;
  cache.set(key, { payload, expiresAt: Date.now() + ttlMs });
}

function normalizeLocation(location: string): string {
  return location.trim().replace(/[市区县]$/u, "");
}

function resolveCoordinates(location: string, latitude?: number, longitude?: number): Coordinates | undefined {
  if (latitude !== undefined && longitude !== undefined) {
    return { latitude, longitude };
  }
  const normalized = normalizeLocation(location);
  return CITY_COORDINATES[location] ?? CITY_COORDINATES[normalized];
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "VexBot/1.0",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}: ${text || response.statusText}`);
    }
    return response.json() as Promise<unknown>;
  } finally {
    clearTimeout(timeout);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function firstRecord(value: unknown): Record<string, unknown> | undefined {
  return Array.isArray(value) && isRecord(value[0]) ? value[0] : undefined;
}

function caiyunSkycon(code: unknown): string | undefined {
  const value = str(code);
  return value ? (SKYCON_ZH[value] ?? value) : undefined;
}

async function queryWttr(params: {
  location: string;
  baseUrl: string;
  timeoutMs: number;
}): Promise<Record<string, unknown>> {
  const url = new URL(`${params.baseUrl.replace(/\/+$/u, "")}/${encodeURIComponent(params.location)}`);
  url.searchParams.set("format", "j1");
  url.searchParams.set("lang", "zh");

  const data = await fetchJson(url.toString(), params.timeoutMs);
  if (!isRecord(data)) throw new Error("Unexpected wttr response");

  const current = Array.isArray(data.current_condition) ? data.current_condition[0] : undefined;
  const currentRecord = isRecord(current) ? current : {};
  const nearestArea = Array.isArray(data.nearest_area) ? data.nearest_area[0] : undefined;
  const areaRecord = isRecord(nearestArea) ? nearestArea : {};
  const resolvedArea = firstRecord(areaRecord.areaName);
  const weatherDesc = firstRecord(currentRecord.weatherDesc);
  const zhDesc = firstRecord(currentRecord.lang_zh);
  const weather = Array.isArray(data.weather) ? data.weather.slice(0, 3) : [];

  return {
    provider: "wttr",
    location: params.location,
    resolvedLocation: str(resolvedArea?.value) ?? params.location,
    current: {
      temperatureC: Number(currentRecord.temp_C),
      feelsLikeC: Number(currentRecord.FeelsLikeC),
      humidity: Number(currentRecord.humidity),
      windKmph: Number(currentRecord.windspeedKmph),
      windDirection: currentRecord.winddir16Point,
      description: str(zhDesc?.value) ?? str(weatherDesc?.value),
      observationTime: currentRecord.observation_time,
    },
    forecast: weather.map((item) => {
      const record = isRecord(item) ? item : {};
      return {
        date: record.date,
        maxTempC: Number(record.maxtempC),
        minTempC: Number(record.mintempC),
        avgTempC: Number(record.avgtempC),
        sunHour: Number(record.sunHour),
      };
    }),
    raw: data,
  };
}

async function queryCaiyun(params: {
  location: string;
  coordinates: Coordinates;
  token: string;
  apiVersion: "v2.6" | "v3";
  timeoutMs: number;
  days: number;
}): Promise<Record<string, unknown>> {
  const { latitude, longitude } = params.coordinates;
  const url = new URL(`https://api.caiyunapp.com/${params.apiVersion}/${params.token}/${longitude},${latitude}/weather`);
  url.searchParams.set("alert", "true");
  url.searchParams.set("dailysteps", String(params.days));
  url.searchParams.set("hourlysteps", "24");
  url.searchParams.set("unit", "metric:v2");

  const data = await fetchJson(url.toString(), params.timeoutMs);
  if (!isRecord(data)) throw new Error("Unexpected Caiyun response");
  const result = isRecord(data.result) ? data.result : {};
  const realtime = isRecord(result.realtime) ? result.realtime : {};
  const daily = isRecord(result.daily) ? result.daily : {};
  const lifeIndex = isRecord(daily.life_index) ? daily.life_index : {};

  const dailyTemperature = Array.isArray(daily.temperature) ? daily.temperature.slice(0, params.days) : [];
  const dailySkycon = Array.isArray(daily.skycon) ? daily.skycon.slice(0, params.days) : [];
  const dailyPrecipitation = Array.isArray(daily.precipitation) ? daily.precipitation.slice(0, params.days) : [];

  return {
    provider: "caiyun",
    location: params.location,
    coordinates: params.coordinates,
    current: {
      temperatureC: num(realtime.temperature),
      apparentTemperatureC: num(realtime.apparent_temperature),
      humidity: num(realtime.humidity),
      skycon: str(realtime.skycon),
      skyconText: caiyunSkycon(realtime.skycon),
      wind: realtime.wind,
      airQuality: realtime.air_quality,
      lifeIndex: realtime.life_index,
    },
    forecast: dailyTemperature.map((item, index) => {
      const temp = isRecord(item) ? item : {};
      const sky = isRecord(dailySkycon[index]) ? dailySkycon[index] as Record<string, unknown> : {};
      const precipitation = isRecord(dailyPrecipitation[index]) ? dailyPrecipitation[index] as Record<string, unknown> : {};
      return {
        date: temp.date ?? sky.date,
        maxTempC: num(temp.max),
        minTempC: num(temp.min),
        avgTempC: num(temp.avg),
        skycon: str(sky.value),
        skyconText: caiyunSkycon(sky.value),
        precipitationAvg: num(precipitation.avg),
      };
    }),
    lifeIndex,
    alert: result.alert,
    raw: data,
  };
}

export function createWeatherTool(options?: WeatherToolOptions): AgentTool {
  const config = options?.config;
  return {
    name: "weather",
    label: "Weather",
    description:
      "Query current weather and short forecast. Supports wttr (free) and Caiyun (requires config.weather.caiyun_api_key). For Caiyun, provide latitude/longitude or a known city name.",
    parameters: Type.Object({
      location: Type.Optional(Type.String({ description: "City or place name, e.g. 香港, 深圳, Beijing" })),
      latitude: Type.Optional(Type.Number({ description: "Latitude, recommended for Caiyun queries" })),
      longitude: Type.Optional(Type.Number({ description: "Longitude, recommended for Caiyun queries" })),
      days: Type.Optional(Type.Number({ description: "Forecast days, 1-7, default 3", minimum: 1, maximum: 7 })),
      provider: Type.Optional(Type.Union([
        Type.Literal("wttr"),
        Type.Literal("caiyun"),
      ], { description: "Override configured provider" })),
    }),
    execute: async (_toolCallId, args) => {
      try {
        const params = args as Record<string, unknown>;
        const provider = (readStringParam(params, "provider") ?? config?.weather_provider ?? "wttr") as WeatherProvider;
        if (provider !== "wttr" && provider !== "caiyun") {
          return errorResult(`Unsupported weather provider: ${provider}`);
        }
        const location = readStringParam(params, "location") ?? config?.default_location ?? "";
        const latitude = readNumberParam(params, "latitude", { min: -90, max: 90 });
        const longitude = readNumberParam(params, "longitude", { min: -180, max: 180 });
        const days = Math.max(1, Math.min(7, readNumberParam(params, "days", { min: 1, max: 7 }) ?? 3));
        const timeoutMs = config?.request_timeout_ms ?? DEFAULT_TIMEOUT_MS;
        const ttlMs = config?.cache_ttl_ms ?? DEFAULT_CACHE_TTL_MS;

        if (!location && (latitude === undefined || longitude === undefined)) {
          return errorResult("location or latitude/longitude is required");
        }

        const cacheKey = JSON.stringify({ provider, location, latitude, longitude, days });
        const cached = readCache(cacheKey);
        if (cached) return jsonResult({ ...(cached as Record<string, unknown>), cached: true });

        let result: Record<string, unknown>;
        if (provider === "caiyun") {
          const token = config?.caiyun_api_key?.trim();
          if (!token) {
            return errorResult("Caiyun weather requires config.weather.caiyun_api_key");
          }
          const coordinates = resolveCoordinates(location, latitude, longitude);
          if (!coordinates) {
            return errorResult("Caiyun weather requires latitude/longitude or a known city name");
          }
          result = await queryCaiyun({
            location: location || `${coordinates.latitude},${coordinates.longitude}`,
            coordinates,
            token,
            apiVersion: config?.caiyun_api_version ?? "v2.6",
            timeoutMs,
            days,
          });
        } else {
          result = await queryWttr({
            location: location || `${latitude},${longitude}`,
            baseUrl: config?.wttr_base_url ?? "https://wttr.in",
            timeoutMs,
          });
        }

        writeCache(cacheKey, result, ttlMs);
        return jsonResult(result);
      } catch (error) {
        return errorResult(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}
