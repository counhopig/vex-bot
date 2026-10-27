/** What the owner wants done with one shared link: archive it into the wiki, only read it, or wait. */
export interface LinkIntent { url: string; intent: "archive" | "read" | "defer"; confidence: number }

/** An outside classifier of link intent, such as TypeSafe Jev. */
export interface LinkClassifier {
  classifyLinks(input: string, urls: string[], signal?: AbortSignal): Promise<LinkIntent[]>;
}
