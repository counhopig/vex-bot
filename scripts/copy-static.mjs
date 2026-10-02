import { cpSync } from "node:fs";

cpSync("src/web/static", "dist/web/static", { recursive: true });
