---
name: weather
description: Look up the current weather and the three-day forecast for a place.
---

# Weather

Use `scripts/weather.mjs` in this directory to query the wttr.in weather service. The city name or coordinates must come from the owner's request or from workspace material.

```bash
node "<this skill's directory>/scripts/weather.mjs" "Hong Kong"
```

The output is JSON with the location, the current conditions and a three-day forecast. Tell the owner the temperature, the conditions and the forecast; if the service fails, say so and never make up weather.
