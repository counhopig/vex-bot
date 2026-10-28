import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";

// The bash sandbox helper is Linux-only and optional: without a C compiler the build
// goes on, and `tools.sandbox.mode: workspace` reports the helper as missing.
if (process.platform === "linux") {
  mkdirSync("dist/native", { recursive: true });
  const cc = process.env.CC || "cc";
  const result = spawnSync(cc, ["-O2", "-Wall", "-o", "dist/native/vex-sandbox", "native/vex-sandbox.c"], { stdio: "inherit" });
  if (result.status !== 0) console.warn(`Skipped the bash sandbox helper: ${cc} ${result.error ? `is unavailable (${result.error.message})` : "failed"}.`);
}
