/**
 * PersonaBuilder — assembles Section 1 of the system prompt.
 *
 * Architecture doc (§11, System Prompt Assembly):
 *   Section 1: PERSONA (BASE) — always first.
 *   The LLM sees identity first, capabilities second.
 */

import type { PersonaConfig } from "./PersonaConfig.js";
import type { PersonaStorage } from "./PersonaStorage.js";
import type { InboundMessageContext } from "../../channels/ChannelAdapter.js";

function describeTimeOfDay(hour: number): string {
  if (hour < 5) return "深夜";
  if (hour < 9) return "早晨";
  if (hour < 12) return "上午";
  if (hour < 14) return "中午";
  if (hour < 18) return "下午";
  if (hour < 21) return "傍晚";
  return "夜间";
}

function formatUtcOffset(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const minutes = String(absolute % 60).padStart(2, "0");
  return `UTC${sign}${hours}:${minutes}`;
}

export function buildPersonaPrompt(
  config: PersonaConfig,
  storage: PersonaStorage,
  ctx: InboundMessageContext,
): string {
  const lines: string[] = [];
  lines.push("【角色身份】");
  lines.push(`你现在扮演 ${config.personaName}。`);
  lines.push(config.personaBasePrompt);

  if (config.personaReplyStyle) {
    lines.push("");
    lines.push("【回复风格】");
    lines.push(config.personaReplyStyle);
  }

  if (config.timeAwarenessEnabled) {
    const now = new Date(ctx.timestamp);
    const formatted = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const weekday = new Intl.DateTimeFormat("zh-CN", { weekday: "long" }).format(now);
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "system-local";
    const timeOfDay = describeTimeOfDay(now.getHours());
    lines.push("");
    lines.push("【当前时间】");
    lines.push(`${formatted} ${weekday}`);
    lines.push(`时区: ${timezone} (${formatUtcOffset(now)})`);
    lines.push(`当前时段: ${timeOfDay}`);
    lines.push(`回复中的早晚、问候和作息描述必须与“当前时段”一致，不得把${timeOfDay}描述成其他时段。`);
  }

  if (config.emotionEnabled) {
    const emotion = storage.getEmotion();
    lines.push("");
    lines.push("【情绪状态】");
    const energyDesc = emotion.energy > 60 ? "精力充沛" : emotion.energy > 30 ? "略有疲惫" : "疲惫";
    const moodDesc = emotion.mood > 60 ? "心情愉悦" : emotion.mood > 30 ? "平静" : "低落";
    lines.push(`精力: ${energyDesc} (${emotion.energy}/100), 情绪: ${moodDesc} (${emotion.mood}/100)`);
  }

  const profile = storage.getProfile();
  const profileKeys = Object.keys(profile);
  if (profileKeys.length > 0) {
    lines.push("");
    lines.push("【用户画像】");
    for (const key of profileKeys) {
      lines.push(`  · [${key}] ${profile[key]}`);
    }
  }

  const history = storage.getHistory();
  if (history.length > 0) {
    lines.push("");
    lines.push("【近期对话】");
    for (const entry of history.slice(-6)) {
      lines.push(`  ${entry}`);
    }
  }

  return lines.join("\n");
}
