import { resolveToolPath } from "./paths.js";

const MAX_SUMMARY = 300;

export function summarizeArgs(toolName: string, args: unknown): string {
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const pick = (key: string): string | undefined => {
    const value = record[key];
    return typeof value === "string" ? value : undefined;
  };
  const text = (toolName === "bash" ? pick("command") : undefined) ?? (toolName === "wiki_ingest" ? pick("url") ?? pick("text") : undefined) ?? pick("path") ?? pick("pattern") ?? JSON.stringify(args ?? {});
  return text.length > MAX_SUMMARY ? `${text.slice(0, MAX_SUMMARY)}…` : text;
}

const MAX_DETAIL = 10000;

export function approvalDetail(toolName: string, args: unknown, workspace?: string): string {
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const pick = (key: string): string | undefined => {
    const value = record[key];
    return typeof value === "string" ? value : undefined;
  };
  let text: string;
  const path = pick("path");
  if (toolName === "wiki_bootstrap" && Array.isArray(record.pages) && pick("commit")) {
    const pages = record.pages.filter((page): page is string => typeof page === "string");
    text = [`Wiki bootstrap generated ${pages.length} files. They have not been pushed.`, `Commit: ${pick("commit")!.slice(0, 12)}`, "Page summary:", ...pages.slice(0, 8).map((page) => `- ${page}`), ...(pages.length > 8 ? [`${pages.length - 8} more files.`] : []), "Approval pushes to the notes repository; rejection discards only the local preview."].join("\n");
  } else if (toolName === "bash" && pick("command") !== undefined) {
    text = pick("command")!;
  } else if ((toolName === "write" || toolName === "edit") && path !== undefined) {
    const resolved = workspace === undefined ? path : resolveToolPath(workspace, path);
    const content = toolName === "write" ? pick("content") : undefined;
    text = content === undefined ? resolved : `${resolved}\n${content}`;
  } else {
    text = JSON.stringify(args ?? {});
  }
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}… (truncated; ${text.length} characters in total)` : text;
}
