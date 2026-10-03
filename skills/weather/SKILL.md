---
name: weather
description: 查询指定地点的当前天气与未来三天天气预报。
---

# 天气

使用本目录中的 `scripts/weather.mjs` 查询 wttr.in 天气服务。城市名或经纬度必须由用户请求或工作区资料确定。

```bash
node "<本技能目录>/scripts/weather.mjs" "香港"
```

输出为 JSON，包含地点、当前天气与未来三天预报。向主人说明温度、天气状况和预报；服务失败时如实说明，不编造天气。
