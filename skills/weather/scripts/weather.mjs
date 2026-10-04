import { pathToFileURL } from "node:url";

export async function queryWeather(location, fetchFn = fetch) {
  if (typeof location !== "string" || !location.trim()) throw new Error("Provide a city name or coordinates");
  const url = new URL(`https://wttr.in/${encodeURIComponent(location.trim())}`);
  url.searchParams.set("format", "j1");
  url.searchParams.set("lang", "zh");
  const response = await fetchFn(url, { signal: AbortSignal.timeout(15_000), redirect: "error" });
  if (!response.ok) throw new Error(`The weather service returned HTTP ${response.status}`);
  const data = await response.json();
  const current = data.current_condition?.[0];
  if (!current || !Array.isArray(data.weather)) throw new Error("The weather service returned invalid data");
  return {
    location: data.nearest_area?.[0]?.areaName?.[0]?.value ?? location,
    current: {
      temperatureC: current.temp_C,
      feelsLikeC: current.FeelsLikeC,
      humidity: current.humidity,
      windKmph: current.windspeedKmph,
      description: current.lang_zh?.[0]?.value ?? current.weatherDesc?.[0]?.value,
      observedAt: current.observation_time,
    },
    forecast: data.weather.slice(0, 3).map((day) => ({ date: day.date, minTempC: day.mintempC, maxTempC: day.maxtempC })),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await queryWeather(process.argv[2]), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
