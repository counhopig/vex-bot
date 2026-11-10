/** A link's original source, read from the web by the bundled link-reader skill or a plain page fetch. */
export interface OriginalSource {
  requestedUrl: string;
  canonicalUrl: string;
  title: string;
  text: string;
  textKind: "text" | "article" | "subtitles" | "transcript";
  truncated: boolean;
}
