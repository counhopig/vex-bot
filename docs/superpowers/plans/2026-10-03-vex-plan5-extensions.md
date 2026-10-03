# Vex 计划 5：扩展能力

依据 `docs/superpowers/specs/2026-10-02-vex-design.md` §7.1、§7.2、§7.4、§11。

## 1. 网页工具

文件：`src/tools/web.ts`、`tests/tools-web.test.ts`。

- 注册 `web_fetch(url, maxLength?)`，抓取公开 HTTP/HTTPS 页面并输出 Markdown。
- 验证 URL 协议、凭证、内网与保留 IP、元数据域名；在连接阶段验证 DNS 的全部地址，防止 DNS 重绑定。
- 手动重定向，每一跳重新验证，最多五跳；限制下载体积 2 MB、默认超时 30 秒，支持调用取消。
- HTML 转 Markdown 保留标题、链接与代码块，移除脚本与样式；输出默认 10,000 字符。
- `web_search(query, count?, country?)` 使用 `webSearch.provider: brave`，凭证取配置 `apiKey`，缺省取 `BRAVE_API_KEY`。
- 搜索通过 Brave 的 `GET /res/v1/web/search` 返回标题、URL、摘要及发布时间；未配置或服务错误返回工具错误。
- 本地 mock 验证 HTTP 错误、超时、中断、DNS 内网地址、IPv4/IPv6、重定向内网、Markdown 与搜索请求参数。

## 2. MCP 桥

文件：`src/tools/mcp.ts`、`tests/tools-mcp.test.ts`。

- 通过 MCP SDK 连接 `mcpServers` 中的 stdio 或 Streamable HTTP 服务。
- stdio 接受 `command`、`args`、`env`、`cwd`；HTTP 接受 `url`、`headers`。
- 读取分页工具清单，把 input schema 保留为 pi 工具参数，名称为 `mcp__<server>__<tool>`。
- 启动连接失败仅记录错误并后台指数退避重试；断线期间保留工具声明，执行返回错误；重连后刷新清单。
- 支持服务工具列表变化通知、工具取消及关闭时清理子进程、HTTP 连接与重连定时器。
- MCP 工具沿用主会话审批 gate，缺省 `ask`，按工具或服务覆写策略。
- 本地真实 SDK stdio 与 HTTP 假服务验证工具发现、响应、错误标记、失败启动、取消和重连。

## 3. 子 agent

文件：`src/tools/delegate.ts`、`tests/tools-delegate.test.ts`。

- `delegate(task, tools?)` 创建独立临时 pi Agent，初始历史为空。
- system prompt 只注入基础指令、当前 `SOUL.md` 与任务；不复制父会话、`USER.md` 或 `MEMORY.md`。
- 默认工具集为主会话工具去掉 `delegate`，指定子集时校验全部工具名称；不能递归委派。
- 使用主会话模型、API key 获取方式、审批 gate；调用的中断信号取消子 agent。
- 仅返回最终助手回复，子 agent 文本与工具进度通过原生 `onUpdate` 推送为主会话工具进度。
- 标记 `executionMode: parallel`，允许同轮多个委派并行。
- Faux 模型验证隔离、工具子集、共享审批、禁止递归、进度、中断及模型失败。

## 4. Skills

文件：`src/skills/discovery.ts`、`src/skills/index.ts`、`tests/skills.test.ts`、`tests/skill-scripts.test.ts`、`skills/`。

- 发现直接子目录中的 `SKILL.md`，读取 Agent Skills `name` / `description` YAML frontmatter。
- 合并包内置技能与工作区 `skills/`，同名工作区优先；每轮重新发现，新增技能下一轮生效。
- prompt 只列名称、简介、路径；正文由 `read` 按需读取，脚本由 `bash` 执行并遵循审批。
- 天气技能使用 wttr.in，图片技能复用配置中的模型注册表，仅使用声明支持图片的模型，不猜测模型与协议。
- 脚本支持错误返回与请求超时；测试只使用本地 HTTP mock 和模型 mock，不调用收费服务。
- 构建复制 `skills/` 到 `dist/skills/`；包发布包含完整 SKILL.md、脚本与资源，发布目录中的相对路径保持可运行。

## 5. 接线与验收

- daemon 启动 MCP 桥并收集扩展工具，按会话创建带共享 gate 的 delegate；MCP 更新后刷新已有会话工具。
- system prompt 在长期记忆后、时间信息前加入 Skills 清单。
- `tool_execution_update` 经 core 事件与 WebSocket 协议传递到 WebChat，显示子 agent 进度。
- 关闭 daemon 时停止调度、会话、MCP 与 HTTP；单步关闭失败仍执行后续步骤。
- 配置 schema 与设置页识别 Brave 搜索及 stdio/HTTP MCP 参数，不暴露 API key。
- 完成扩展模块测试、全量测试、`npm run lint`、`npm run build`，检查打包资源与导入路径。
