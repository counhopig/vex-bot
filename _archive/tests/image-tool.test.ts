import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createImageAnalyzeTool, buildImageAnalysisContent } from "../src/tools/builtin/image.js";

function payload(result: { content: Array<{ text?: string }> }): any {
  return JSON.parse(result.content.map((c) => c.text ?? "").join(""));
}

describe("tools/builtin/image", () => {
  const dirs: string[] = [];
  function sandbox(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "vex-img-")));
    dirs.push(dir);
    return dir;
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  describe("buildImageAnalysisContent", () => {
    it("emits a real image content block, not a text placeholder", () => {
      const content = buildImageAnalysisContent("what is this", "AAAA", "image/png");
      const image = content.find((c) => c.type === "image");
      expect(image).toBeDefined();
      expect(image).toMatchObject({ type: "image", data: "AAAA", mimeType: "image/png" });
      const text = content.find((c) => c.type === "text");
      expect(text).toMatchObject({ type: "text", text: "what is this" });
    });
  });

  it("refuses to read a file outside the allowed sandbox", async () => {
    const dir = sandbox();
    const outside = sandbox();
    writeFileSync(join(outside, "secret.png"), "binary");
    const tool = createImageAnalyzeTool({ allowedPaths: [dir] });

    const result = await tool.execute("i", { image: join(outside, "secret.png") }, undefined);

    expect(result.isError).toBeTruthy();
    expect(payload(result).error).toMatch(/denied|not found|invalid/i);
  });

  it("rejects remote URLs instead of silently sending a text placeholder", async () => {
    const tool = createImageAnalyzeTool({ allowedPaths: [sandbox()] });
    const result = await tool.execute("i", { image: "http://169.254.169.254/latest/" }, undefined);
    expect(result.isError).toBeTruthy();
  });
});
