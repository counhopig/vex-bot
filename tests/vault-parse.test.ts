import { describe, expect, it } from "vitest";
import { bodyOf, buildBacklinks, buildResolver, parseNote } from "../src/vault/parse.js";

describe("parseNote", () => {
  it("reads the title, frontmatter tags and aliases", () => {
    const meta = parseNote("Projects/Vex.md", "---\ntags: [ai, project/vex]\naliases: Vex Bot, vex\n---\n# Vex\nBody");
    expect(meta).toMatchObject({ title: "Vex", tags: ["ai", "project/vex"], aliases: ["Vex Bot", "vex"] });
  });

  it("accepts tags written as a string and ignores broken frontmatter", () => {
    expect(parseNote("a.md", '---\ntags: "one two, #three"\n---\nText').tags).toEqual(["one", "two", "three"]);
    const broken = parseNote("a.md", "---\ntags: [unclosed\n---\n# T\n#real");
    expect(broken.tags).toEqual(["real"]);
    expect(bodyOf("---\ntags: [x]\n---\nBody\n")).toBe("Body\n");
    expect(bodyOf("No frontmatter")).toBe("No frontmatter");
  });

  it("finds inline tags but not headings, urls, plain numbers or code", () => {
    const text = "# Heading\nUse #idea and #area/work here. Link https://x.y/z#frag costs #123.\n```\n#incode\n```\nAlso `#inline` and #中文标签.";
    expect(parseNote("a.md", text).tags).toEqual(["idea", "area/work", "中文标签"]);
  });

  it("collects wiki links, embeds and markdown links to notes", () => {
    const text = "[[Alpha]] [[Beta|alias]] [[Gamma#Heading]] [[Folder/Delta]] ![[Epsilon]] ![[photo.png]] [[#local]] "
      + "[x](../Zeta.md#top) [y](https://e.x/a.md) [z](img.png) [w](/Root.md) `[[Code]]` [[Alpha]]";
    expect(parseNote("Notes/a.md", text).links).toEqual([
      { kind: "wiki", target: "Alpha" },
      { kind: "wiki", target: "Beta" },
      { kind: "wiki", target: "Gamma" },
      { kind: "wiki", target: "Folder/Delta" },
      { kind: "wiki", target: "Epsilon" },
      { kind: "markdown", target: "Zeta.md" },
      { kind: "markdown", target: "Root.md" },
    ]);
  });
});

describe("link resolution", () => {
  const notes = new Map([
    ["Inbox/Idea.md", parseNote("Inbox/Idea.md", "[[Vex]] [[Missing]] [[Projects/Plan]]")],
    ["Projects/Vex.md", parseNote("Projects/Vex.md", "---\naliases: [Vex Bot]\n---\n[[Idea]]")],
    ["Vex.md", parseNote("Vex.md", "")],
    ["Projects/Plan.md", parseNote("Projects/Plan.md", "[x](../Vex.md)")],
    ["Archive/Projects/Plan.md", parseNote("Archive/Projects/Plan.md", "")],
  ]);

  it("resolves by name, alias and path, preferring the shortest path", () => {
    const resolve = buildResolver(notes);
    expect(resolve({ kind: "wiki", target: "vex" })).toBe("Vex.md");
    expect(resolve({ kind: "wiki", target: "Vex Bot" })).toBe("Projects/Vex.md");
    expect(resolve({ kind: "wiki", target: "Projects/Plan" })).toBe("Projects/Plan.md");
    expect(resolve({ kind: "wiki", target: "Missing" })).toBeNull();
    expect(resolve({ kind: "markdown", target: "vex.md" })).toBe("Vex.md");
  });

  it("lists backlinks once, sorted, without self links", () => {
    const back = buildBacklinks(notes, buildResolver(notes));
    expect(back.get("Vex.md")).toEqual(["Inbox/Idea.md", "Projects/Plan.md"]);
    expect(back.get("Inbox/Idea.md")).toEqual(["Projects/Vex.md"]);
    expect(back.get("Projects/Plan.md")).toEqual(["Inbox/Idea.md"]);
  });
});
