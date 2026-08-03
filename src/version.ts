import { readFileSync } from "fs";

interface PackageMetadata {
  version?: unknown;
}

const metadata = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageMetadata;

export const VERSION = typeof metadata.version === "string" ? metadata.version : "unknown";
