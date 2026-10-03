---
name: image
description: 使用已配置的视觉模型理解本地图片，描述画面或回答图片相关问题。
---

# 图片理解

运行 `scripts/analyze.mjs`，通过 Vex 的模型注册表解析配置模型。模型必须声明支持图片输入；不自动挑选模型或猜测协议。

```bash
node "<本技能目录>/scripts/analyze.mjs" "<图片路径>" "<问题>"
```

可追加 `--config "<config.yaml路径>"`。在 Vex 的 bash 工具中默认使用 `VEX_CONFIG_PATH` 指向的当前配置；独立执行时读取 `VEX_HOME/config.yaml`，未设 `VEX_HOME` 时读取 `~/.vex/config.yaml`。

需要指定其他已配置模型时，同时追加 `--provider "<提供方>" --model "<模型id>"`。API key 通过配置或提供方的环境变量获得；使用环境变量认证时，须在 `bashEnvPassthrough` 中明确放行该变量。不得将密钥写入命令参数。

支持 PNG、JPEG、WebP、GIF，图片上限 10 MB。运行脚本使用 bash，遵循审批。向主人返回分析内容；文件、模型或服务失败时如实报告错误。
