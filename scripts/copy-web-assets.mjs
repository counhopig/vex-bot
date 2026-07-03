import { cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(rootDir, "src", "web", "assets");
const outDir = join(rootDir, "dist", "web", "assets");

if (existsSync(srcDir)) {
  cpSync(srcDir, outDir, { recursive: true });
}
