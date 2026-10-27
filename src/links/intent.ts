/** What the owner wants done with one shared link: archive it into the wiki, only read it, or wait. */
export interface LinkIntent { url: string; intent: "archive" | "read" | "defer"; confidence: number }

/** What a shared link gets when the owner does not say: archived into the wiki, or only read. */
export type DefaultLinkIntent = "archive" | "read";

/** The owner's standing preference, as every link classifier is told it. */
export function intentGuidance(defaultIntent: DefaultLinkIntent): string {
  const preference = defaultIntent === "read"
    ? "The owner's standing preference is to only read shared links. Choose archive only when the owner explicitly asks to save, archive or keep the link."
    : "The owner's standing preference is to archive shared links, including links they ask to check, read or summarize. Choose read only when the owner explicitly says not to save or archive the link.";
  return `${preference} Choose defer when intent is ambiguous or the owner asks for no action.`;
}

/** An outside classifier of link intent, such as TypeSafe Jev. */
export interface LinkClassifier {
  classifyLinks(input: string, urls: string[], signal?: AbortSignal, defaultIntent?: DefaultLinkIntent): Promise<LinkIntent[]>;
}
