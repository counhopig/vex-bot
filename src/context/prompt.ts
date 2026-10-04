import { loadPrompt } from "../workspace/prompts.js";
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
  return () => loadPrompt(workspace, "INSTRUCTIONS.md", { workspace });
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
      `(${opts.file} has ${lines.length} lines, over the ${opts.maxLines}-line limit; the content above is truncated. Please shorten this file.)`,
    ].join("\n");
  };
}

export function timeSection(timeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone): PromptSection {
  return ({ now, windowLabel }) => `## Now\nTime: ${formatNow(now, timeZone)}\nWindow: ${windowLabel}`;
}

export function formatNow(now: Date, timeZone: string): string {
  const parts: Record<string, string> = {};
  const formatter = new Intl.DateTimeFormat("en-US", {
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
  const offset = (parts.timeZoneName ?? "GMT").replace("GMT", "UTC").replace("UTC+00:00", "UTC");
  const hour = Number(parts.hour);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.weekday} (${timeZone}, ${offset}, ${describeTimeOfDay(hour)})`;
}

export function describeTimeOfDay(hour: number): string {
  if (hour < 5) return "late night";
  if (hour < 9) return "early morning";
  if (hour < 12) return "morning";
  if (hour < 14) return "noon";
  if (hour < 18) return "afternoon";
  if (hour < 21) return "evening";
  return "night";
}
