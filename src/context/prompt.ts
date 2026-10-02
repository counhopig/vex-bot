import { readWorkspaceFile } from "../workspace/workspace.js";

export interface PromptContext {
  windowLabel: string;
  now: Date;
}

export type PromptSection = (ctx: PromptContext) => Promise<string | undefined> | string | undefined;

export class SystemPromptBuilder {
  constructor(private readonly sections: PromptSection[]) {}

  async build(ctx: PromptContext): Promise<string> {
    const parts: string[] = [];
    for (const section of this.sections) {
      const text = (await section(ctx))?.trim();
      if (text) parts.push(text);
    }
    return parts.join("\n\n");
  }
}

export function baseInstructionsSection(workspace: string): PromptSection {
  const text = [
    "你是主人的个人助手，运行在主人自己的设备上，只服务主人一个人。主人通过微信或网页与你对话。",
    "",
    "## 工作区",
    `你的工作区是 ${workspace}。文件工具的相对路径基于工作区，bash 的默认工作目录也是工作区。`,
    "工作区中的这些文件构成你的长期状态：",
    "- SOUL.md：你的人设、语气与行为准则",
    "- USER.md：你对主人的认识",
    "- MEMORY.md：提炼后的长期事实与决定，保持在 100 行以内",
    "- memory/YYYY-MM-DD.md：每日笔记",
    "SOUL.md、USER.md、MEMORY.md 的当前内容附在下文。",
    "",
    "## 记忆约定",
    "- 一次性的事实、事件、对话要点：追加到当天的 memory/YYYY-MM-DD.md",
    "- 关于主人的稳定认知：更新 USER.md",
    "- 长期有效的事实与决定：更新 MEMORY.md",
    "- 主人要求改变你的人设或行为准则：更新 SOUL.md",
    "",
    "## 工具与审批",
    "在工作区内读写文件无需批准；写工作区以外的文件和执行 bash 命令需要主人批准。被拒绝时接受结果，换一种方式继续或向主人说明。",
  ].join("\n");
  return () => text;
}

export function residentFileSection(opts: { workspace: string; file: string; maxLines: number }): PromptSection {
  return async () => {
    const content = (await readWorkspaceFile(opts.workspace, opts.file)).trim();
    if (!content) return undefined;
    const lines = content.split("\n");
    if (lines.length <= opts.maxLines) return `## ${opts.file}\n${content}`;
    return [
      `## ${opts.file}`,
      lines.slice(0, opts.maxLines).join("\n"),
      "",
      `（${opts.file} 共 ${lines.length} 行，超过 ${opts.maxLines} 行上限，以上为截断内容。请精简这个文件。）`,
    ].join("\n");
  };
}

export function timeSection(timeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone): PromptSection {
  return ({ now, windowLabel }) => `## 当前\n时间：${formatNow(now, timeZone)}\n窗口：${windowLabel}`;
}

export function formatNow(now: Date, timeZone: string): string {
  const parts: Record<string, string> = {};
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "long",
    timeZoneName: "longOffset",
  });
  for (const part of formatter.formatToParts(now)) parts[part.type] = part.value;
  const offset = (parts.timeZoneName ?? "GMT").replace("GMT", "UTC");
  const hour = Number(parts.hour);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.weekday}（${timeZone}，${offset}，${describeTimeOfDay(hour)}）`;
}

export function describeTimeOfDay(hour: number): string {
  if (hour < 5) return "深夜";
  if (hour < 9) return "早晨";
  if (hour < 12) return "上午";
  if (hour < 14) return "中午";
  if (hour < 18) return "下午";
  if (hour < 21) return "傍晚";
  return "夜间";
}
