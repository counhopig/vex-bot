/**
 * Browser-side i18n runtime injected into the inline WebChat and Control UIs.
 *
 * The frontend has no build step, so translations live here as data and are
 * serialized into a small global helper before page-specific client scripts.
 */

const zh: Record<string, string> = {
  "Console": "控制台",
  "Monitor": "监控",
  "Overview": "概览",
  "Sessions": "会话",
  "Configuration": "配置",
  "Config": "配置",
  "Settings": "设置",
  "Model Providers": "模型提供商",
  "Channels": "渠道",
  "Tools": "工具",
  "Logs": "日志",
  "Back to Chat": "返回聊天",
  "System Overview": "系统概览",
  "View system runtime status and key metrics": "查看系统运行状态和关键指标",
  "Connection Status": "连接状态",
  "Connecting": "连接中",
  "Connecting...": "连接中...",
  "Connected": "已连接",
  "Disconnected": "已断开",
  "Uptime": "运行时间",
  "since startup": "自启动以来",
  "WebSocket Connections": "WebSocket 连接",
  "Current browser clients": "当前浏览器客户端",
  "Default Model": "默认模型",
  "System Info": "系统信息",
  "Refresh": "刷新",
  "Version": "版本",
  "Session Management": "会话管理",
  "View and manage active chat sessions": "查看和管理已保存的聊天会话",
  "Stored Sessions": "已保存会话",
  "Session ID": "会话 ID",
  "Channel": "渠道",
  "Messages": "消息数",
  "Last Active": "最近活跃",
  "Actions": "操作",
  "No active sessions": "暂无活跃会话",
  "No recent sessions": "暂无最近会话",
  "No stored sessions": "暂无已保存会话",
  "Loading...": "加载中...",
  "Loading sessions...": "正在加载会话...",
  "Failed to load sessions": "加载会话失败",
  "View configured AI model providers and available models": "查看已配置的 AI 模型提供商和可用模型",
  "View configured channel platform connection status": "查看已配置渠道平台的连接状态",
  "Status": "状态",
  "Type": "类型",
  "Configuration Management": "配置管理",
  "Visually configure model providers, channels, and system settings": "可视化配置模型提供商、渠道和系统设置",
  "Refresh Config": "刷新配置",
  "Save All Changes": "保存全部更改",
  "Agent": "Agent",
  "Server": "服务器",
  "Memory": "记忆",
  "Agent Settings": "Agent 设置",
  "Default Provider": "默认提供商",
  "Temperature": "温度",
  "Max Tokens": "最大 Token 数",
  "System Prompt": "系统提示词",
  "+ Add Provider": "+ 添加提供商",
  "Personal WeChat": "个人微信",
  "Personal WeChat uses QR code login, no manual credentials needed": "个人微信使用二维码登录，无需手动填写凭据",
  "Bot Type (default: 3)": "机器人类型（默认：3）",
  "API Base URL (default: https://ilinkai.weixin.qq.com)": "API 基础地址（默认：https://ilinkai.weixin.qq.com）",
  "Status: Not logged in (click below to scan QR code)": "状态：未登录（点击下方扫码）",
  "Scan QR Login": "扫码登录",
  "Waiting for scan...": "等待扫码...",
  "Server Settings": "服务器设置",
  "Port": "端口",
  "Host": "主机",
  "Log Level": "日志级别",
  "Debug": "调试",
  "Info": "信息",
  "Warn": "警告",
  "Error": "错误",
  "Changing server port requires a restart to take effect": "修改服务器端口需要重启后生效",
  "Enable Long-Term Memory": "启用长期记忆",
  "Allow Agent to remember user preferences and important info across sessions": "允许 Agent 跨会话记住用户偏好和重要信息",
  "Storage Directory": "存储目录",
  "Edit bot persona, extensions, weather, skills, sessions, and raw config": "编辑机器人人格、扩展、天气、技能、会话和原始配置",
  "Refresh Settings": "刷新设置",
  "Save Settings": "保存设置",
  "Bot / Persona": "机器人 / 人格",
  "Extensions": "扩展",
  "Weather": "天气",
  "Skills": "技能",
  "Geek (Raw JSON)": "极客（原始 YAML）",
  "Bot Persona": "机器人人格",
  "Enable Persona System": "启用人格系统",
  "Persona Name": "人格名称",
  "Reply Style": "回复风格",
  "Base Prompt": "基础提示词",
  "Time Awareness": "时间感知",
  "Emotion System": "情绪系统",
  "Emotion Decay / Hour": "每小时情绪衰减",
  "Emotion Recovery / Reply": "每次回复情绪恢复",
  "Emotion Injection Style": "情绪注入风格",
  "Emotion Decay Cron": "情绪衰减 Cron",
  "Memory Max Turns": "记忆最大轮数",
  "Reflection": "反思",
  "Reflection Trigger Turns": "反思触发轮数",
  "Reflection History Turns": "反思历史轮数",
  "Reflection Periodic Cron": "定期反思 Cron",
  "Profile": "画像",
  "Profile Building": "画像构建",
  "Profile Building Trigger Turns": "画像构建触发轮数",
  "Rest / Sleep": "休息 / 睡眠",
  "Proactive Nudge": "主动提醒",
  "Rest Sleep Hour (0-23)": "休息开始小时（0-23）",
  "Rest Wake Hour (0-23)": "休息结束小时（0-23）",
  "Proactive Nudge Cron": "主动提醒 Cron",
  "Greeting On First Chat": "首次聊天问候",
  "Goodnight Hint": "晚安提示",
  "Debug Log": "调试日志",
  "Skill Learner": "技能学习器",
  "Enable Skill Learner": "启用技能学习器",
  "Auto Trigger Keywords (comma-separated)": "自动触发关键词（逗号分隔）",
  "Max Learning Turns": "最大学习轮数",
  "Proactive Threshold (0-1)": "主动建议阈值（0-1）",
  "Enable Auto Learn": "启用自动学习",
  "Enable Proactive Suggest": "启用主动建议",
  "Auto Deploy To Skills": "自动部署到技能",
  "Enable ShareLink": "启用 ShareLink",
  "Response Mode": "响应模式",
  "Description Max Length": "描述最大长度",
  "Include Description": "包含描述",
  "Include Cover": "包含封面",
  "Auto Detect": "自动检测",
  "Audio Download Timeout (ms)": "音频下载超时（毫秒）",
  "Subtitle Max Length": "字幕最大长度",
  "LLM Short Content Threshold": "LLM 短内容阈值",
  "LLM Chunk Size": "LLM 分块大小",
  "Bilibili Cookie (leave blank to keep existing)": "Bilibili Cookie（留空则保留现有值）",
  "No cookie configured": "未配置 Cookie",
  "Cookie configured (leave blank to keep)": "已配置 Cookie（留空则保留）",
  "Weather Provider": "天气数据提供商",
  "wttr is free and needs no API key; Caiyun is more precise and requires an API key": "wttr 免费且无需 API Key；彩云天气更精准，需要 API Key",
  "Caiyun API Version": "彩云天气 API 版本",
  "Caiyun API Key / Token (leave blank to keep existing)": "彩云天气 API Key / Token（留空则保留现有值）",
  "No Caiyun API key configured": "未配置彩云天气 API Key",
  "Caiyun API key configured (leave blank to keep)": "已配置彩云天气 API Key（留空则保留）",
  "Default Location": "默认位置",
  "wttr Base URL": "wttr 基础地址",
  "Request Timeout (ms)": "请求超时（毫秒）",
  "Cache TTL (ms)": "缓存 TTL（毫秒）",
  "Enable Skills": "启用技能",
  "User Directory": "用户目录",
  "Workspace Directory": "工作区目录",
  "Disabled Skills (comma-separated)": "禁用技能（逗号分隔）",
  "Only Skills (comma-separated, overrides disabled)": "仅启用技能（逗号分隔，会覆盖禁用列表）",
  "Sessions Store": "会话存储",
  "Store Type": "存储类型",
  "Changing the store type requires a restart to take effect": "修改存储类型需要重启后生效",
  "Directory (file store)": "目录（文件存储）",
  "Session TTL (ms)": "会话 TTL（毫秒）",
  "Raw YAML Editor": "原始 YAML 编辑器",
  "Edit arbitrary config as YAML. On save, this patch is merged last and overrides form fields above. Top-level must be a mapping.": "以 YAML 编辑任意配置。保存时该补丁最后合并，并覆盖上方表单字段。顶层必须是映射对象。",
  "YAML Patch": "YAML 补丁",
  "Validate YAML": "验证 YAML",
  "System Logs": "系统日志",
  "View real-time system runtime logs": "查看实时系统运行日志",
  "Waiting for connection...": "等待连接...",
  "Add Provider": "添加提供商",
  "Provider Type": "提供商类型",
  "Base URL": "基础地址",
  "Display Name": "显示名称",
  "Group ID (MiniMax)": "Group ID（MiniMax）",
  "API Key": "API Key",
  "Cancel": "取消",
  "Add": "添加",
  "No providers configured": "未配置提供商",
  "Configured": "已配置",
  "Not configured": "未配置",
  "Edit": "编辑",
  "Delete": "删除",
  "Online": "在线",
  "Offline": "离线",
  "Available": "可用",
  "Unavailable": "不可用",
  "Delete this session?": "确定删除这个会话吗？",
  "Are you sure you want to delete this session?": "确定要删除这个会话吗？",
  "Session deleted": "会话已删除",
  "Status refreshed": "状态已刷新",
  "Config loaded": "配置已加载",
  "Settings loaded": "设置已加载",
  "Failed to get status": "获取状态失败",
  "Failed to delete session": "删除会话失败",
  "Failed to load config": "加载配置失败",
  "Failed to save config": "保存配置失败",
  "Failed to load settings": "加载设置失败",
  "Failed to save settings": "保存设置失败",
  "Failed to get QR code": "获取二维码失败",
  "Please enter API Key": "请输入 API Key",
  "Please enter Base URL": "请输入 Base URL",
  "Provider added (click Save to apply changes)": "提供商已添加（点击保存后生效）",
  "Provider updated (click Save to apply changes)": "提供商已更新（点击保存后生效）",
  "Are you sure you want to remove this provider?": "确定要删除这个提供商吗？",
  "Provider removed (click Save to apply changes)": "提供商已删除（点击保存后生效）",
  "Getting QR code...": "正在获取二维码...",
  "Refresh QR": "刷新二维码",
  "Logged in ✓": "已登录 ✓",
  "Status: Logged in (Token valid)": "状态：已登录（Token 有效）",
  "Status: Not logged in": "状态：未登录",
  "Status: Not logged in (scan QR in terminal or restart to auto-login)": "状态：未登录（在终端扫码或重启后自动登录）",
  "WeChat login successful! Click \"Save All Changes\" and restart the service.": "微信登录成功！点击“保存全部更改”并重启服务。",
  "QR code expired, please refresh": "二维码已过期，请刷新",
  "Raw YAML editor is empty — nothing to validate.": "原始 YAML 编辑器为空，无需验证。",
  "YAML will be validated by the server when you save.": "保存时服务端会验证 YAML。",
  "Connected to server": "已连接到服务器",
  "Connection lost, reconnecting...": "连接断开，正在重连...",
  "Stored sessions loaded": "已加载保存的会话",
  "providers": "个提供商",
  "channels": "个渠道",
  "sessions": "个会话",
  "messages": "条消息",
  "0 sessions": "0 个会话",
  "+ New Chat": "+ 新聊天",
  "Welcome to Vex": "欢迎使用 Vex",
  "I'm an AI assistant powered by Chinese LLMs, here to help with questions, coding, data analysis, and more.": "我是由中文大模型驱动的 AI 助手，可以帮你问答、写代码、做数据分析等。",
  "Smart Chat": "智能聊天",
  "Code Assistant": "代码助手",
  "Data Analysis": "数据分析",
  "Tool Calling": "工具调用",
  "Type a message... (Enter to send, Shift+Enter for new line, Esc to cancel)": "输入消息...（Enter 发送，Shift+Enter 换行，Esc 取消）",
  "Clear chat": "清空聊天",
  "Cancel this request": "取消本次请求",
  "Send": "发送",
};

export const I18N_CLIENT_JS = `
window.VexI18n = (() => {
  const zh = ${JSON.stringify(zh, null, 2)};
  const storageKey = "vex_ui_language";

  function getLang() {
    const saved = localStorage.getItem(storageKey);
    if (saved === "en" || saved === "zh") return saved;
    return navigator.language && navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
  }

  function setLang(lang) {
    localStorage.setItem(storageKey, lang === "zh" ? "zh" : "en");
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  }

  function t(key, vars = {}) {
    let value = getLang() === "zh" && zh[key] ? zh[key] : key;
    for (const [name, replacement] of Object.entries(vars)) {
      value = value.replaceAll("{" + name + "}", String(replacement));
    }
    return value;
  }

  function translateText(text) {
    if (getLang() === "en") {
      for (const [en, translated] of Object.entries(zh)) {
        if (text === translated) return en;
      }
      return text;
    }
    return zh[text] || text;
  }

  function apply(root = document) {
    const base = root.body || root;
    const walker = document.createTreeWalker(base, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    for (const node of nodes) {
      if (node.parentElement?.closest(".log-container")) continue;
      const raw = node.nodeValue || "";
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const translated = translateText(trimmed);
      if (translated !== trimmed) {
        node.nodeValue = raw.replace(trimmed, translated);
      }
    }

    root.querySelectorAll?.("[placeholder], [title], [alt]").forEach((el) => {
      for (const attr of ["placeholder", "title", "alt"]) {
        const value = el.getAttribute(attr);
        if (!value) continue;
        const translated = translateText(value);
        if (translated !== value) el.setAttribute(attr, translated);
      }
    });

    document.documentElement.lang = getLang() === "zh" ? "zh-CN" : "en";
  }

  return { getLang, setLang, t, apply };
})();
`;
