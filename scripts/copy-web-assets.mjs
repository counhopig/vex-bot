import { cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(rootDir, "src", "web", "static", "assets");
const outDir = join(rootDir, "dist", "web", "static", "assets");

if (existsSync(srcDir)) {
  cpSync(srcDir, outDir, { recursive: true });
}
