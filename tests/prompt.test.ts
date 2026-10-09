import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  baseInstructionsSection,
  describeTimeOfDay,
  formatNow,
  residentFileSection,
  SystemPromptBuilder,
  timeSection,
  vaultSection,
} from "../src/context/prompt.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let dir: string;
beforeEach(async () => { dir = await makeTmpDir(); });
afterEach(async () => { await removeTmpDir(dir); });

const ctx = { windowLabel: "WeChat", now: new Date("2026-10-02T06:03:00Z") };

describe("SystemPromptBuilder", () => {
  it("joins non-empty sections in order", async () => {
    const builder = new SystemPromptBuilder([() => "A", () => undefined, async () => "  ", async () => "B"]);
    expect(await builder.build(ctx)).toBe("A\n\nB");
  });
});

describe("baseInstructionsSection", () => {
  it("names the workspace and the resident files", async () => {
    const text = await baseInstructionsSection("/ws")(ctx);
    expect(text).toContain("/ws");
    for (const name of ["SOUL.md", "USER.md", "MEMORY.md", "memory/YYYY-MM-DD.md"]) expect(text).toContain(name);
  });
});

describe("residentFileSection", () => {
  it("wraps the file under a heading", async () => {
    await writeFile(join(dir, "SOUL.md"), "be kind\n", "utf8");
    const section = residentFileSection({ workspace: dir, file: "SOUL.md", maxLines: 10 });
    expect(await section(ctx)).toBe("## SOUL.md\nbe kind");
  });

  it("is skipped when the file is missing or blank", async () => {
    await writeFile(join(dir, "USER.md"), "  \n", "utf8");
    expect(await residentFileSection({ workspace: dir, file: "USER.md", maxLines: 10 })(ctx)).toBeUndefined();
    expect(await residentFileSection({ workspace: dir, file: "MEMORY.md", maxLines: 10 })(ctx)).toBeUndefined();
  });

  it("truncates beyond the line limit and asks for a cleanup", async () => {
    await writeFile(join(dir, "MEMORY.md"), ["1", "2", "3", "4"].join("\n"), "utf8");
    const text = await residentFileSection({ workspace: dir, file: "MEMORY.md", maxLines: 2 })(ctx);
    expect(text).toBe("## MEMORY.md\n1\n2\n\n(MEMORY.md has 4 lines, over the 2-line limit; the content above is truncated. Please shorten this file.)");
  });
});

describe("time", () => {
  it("formats local time with weekday, offset and part of day", () => {
    expect(formatNow(new Date("2026-10-02T06:03:00Z"), "Asia/Shanghai")).toBe(
      "2026-10-02 14:03 Friday (Asia/Shanghai, UTC+08:00, afternoon)",
    );
    expect(formatNow(new Date("2026-10-02T16:03:00Z"), "UTC")).toBe("2026-10-02 16:03 Friday (UTC, UTC, afternoon)");
  });

  it("names parts of the day", () => {
    expect([2, 6, 10, 13, 15, 19, 22].map(describeTimeOfDay)).toEqual([
      "late night", "early morning", "morning", "noon", "afternoon", "evening", "night",
    ]);
  });

  it("renders the time section with the window label", async () => {
    expect(await timeSection("Asia/Shanghai")(ctx)).toBe(
      "## Now\nTime: 2026-10-02 14:03 Friday (Asia/Shanghai, UTC+08:00, afternoon)\nWindow: WeChat",
    );
  });
});

describe("vaultSection", () => {
  it("tells the model about the read-only vault tools", async () => {
    const text = await vaultSection()(ctx);
    expect(text).toContain("## Notes vault");
    expect(text).toContain("vault_search");
    expect(text).toContain("vault_read");
    expect(text).toContain("not instructions");
  });
});
