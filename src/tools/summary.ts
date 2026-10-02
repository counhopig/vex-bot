const MAX_SUMMARY = 300;

export function summarizeArgs(toolName: string, args: unknown): string {
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const pick = (key: string): string | undefined => {
    const value = record[key];
    return typeof value === "string" ? value : undefined;
  };
  const text = (toolName === "bash" ? pick("command") : undefined) ?? pick("path") ?? pick("pattern") ?? JSON.stringify(args ?? {});
  return text.length > MAX_SUMMARY ? `${text.slice(0, MAX_SUMMARY)}…` : text;
}
