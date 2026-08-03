/**
 * Weather config normalization — snake_case UI/YAML records to the typed
 * camelCase EffectiveConfig section.
 *
 * Design decision 4 of the runtime-config integration plan: normalize config
 * shapes at the EffectiveConfig boundary; runtime tools receive typed options
 * (WeatherToolOptions), never raw UI/YAML records.
 */

import type { WeatherToolOptions } from "../tools/builtin/weather.js";

/** Typed, canonical (camelCase) weather section carried by EffectiveConfig. */
export interface EffectiveWeatherConfig {
  provider?: "wttr" | "caiyun";
  caiyunApiKey?: string;
  caiyunApiVersion?: "v2.6" | "v3";
  defaultLocation?: string;
  wttrBaseUrl?: string;
  requestTimeoutMs?: number;
  cacheTtlMs?: number;
}

/** Normalize a raw (YAML/SQLite snake_case) weather section. Undefined when
 *  the section is absent; a blank/empty api key is treated as absent so the
 *  system-level key survives the per-user merge. */
export function normalizeWeatherSection(
  raw: Record<string, unknown> | undefined | null,
): EffectiveWeatherConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;

  const provider = raw.weather_provider;
  const version = raw.caiyun_api_version;
  const apiKey = raw.caiyun_api_key;
  const baseUrl = raw.wttr_base_url;
  const location = raw.default_location;
  const timeout = raw.request_timeout_ms;
  const ttl = raw.cache_ttl_ms;

  const result: EffectiveWeatherConfig = {};
  if (provider === "wttr" || provider === "caiyun") result.provider = provider;
  if (typeof apiKey === "string" && apiKey.trim()) result.caiyunApiKey = apiKey.trim();
  if (version === "v2.6" || version === "v3") result.caiyunApiVersion = version;
  if (typeof baseUrl === "string" && baseUrl) result.wttrBaseUrl = baseUrl;
  if (typeof location === "string" && location) result.defaultLocation = location;
  if (typeof timeout === "number") result.requestTimeoutMs = timeout;
  if (typeof ttl === "number") result.cacheTtlMs = ttl;

  return Object.keys(result).length > 0 ? result : undefined;
}

/** EffectiveConfig.weather → runtime WeatherToolOptions (type-only bridge). */
export function toWeatherToolOptions(
  weather: EffectiveWeatherConfig | undefined,
): WeatherToolOptions | undefined {
  if (!weather) return undefined;

  const options: WeatherToolOptions = {};
  if (weather.provider) options.provider = weather.provider;
  if (weather.caiyunApiKey) options.caiyunApiKey = weather.caiyunApiKey;
  if (weather.caiyunApiVersion) options.caiyunApiVersion = weather.caiyunApiVersion;
  if (weather.defaultLocation) options.defaultLocation = weather.defaultLocation;
  if (weather.wttrBaseUrl) options.wttrBaseUrl = weather.wttrBaseUrl;
  if (weather.requestTimeoutMs !== undefined) options.requestTimeoutMs = weather.requestTimeoutMs;
  if (weather.cacheTtlMs !== undefined) options.cacheTtlMs = weather.cacheTtlMs;
  return options;
}
