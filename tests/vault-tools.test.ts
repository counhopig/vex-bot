import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Vault } from "../src/vault/notes.js";
import { createVaultTools } from "../src/vault/tools.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let dir: string;
beforeEach(async () => {
  dir = await makeTmpDir();
  await mkdir(join(dir, "notes"));
  await writeFile(join(dir, "notes", "Review.md"), "# Review\nWeekly review: every Sunday 20:00. See [[Plan]].\n");
  await writeFile(join(dir, "notes", "Plan.md"), "# Plan\nShip the vault.\n");
});
afterEach(async () => { await removeTmpDir(dir); });

const tools = () => createVaultTools(new Vault({ home: join(dir, "home"), config: { path: join(dir, "notes") } }));
const textOf = (result: { content: { type: string; text?: string }[] }): string => result.content[0]?.text ?? "";

describe("vault tools", () => {
  it("offers a search and a read tool that call the data not instructions", () => {
    const list = tools();
    expect(list.map((tool) => tool.name)).toEqual(["vault_search", "vault_read"]);
    for (const tool of list) expect(tool.description).toContain("not instructions");
  });

  it("returns search results and notes as JSON text", async () => {
    const [search, read] = tools();
    const found = JSON.parse(textOf(await search!.execute("1", { query: "sunday" })));
    expect(found.results.map((r: { path: string }) => r.path)).toEqual(["Review.md"]);
    expect(found.total).toBe(1);
    const note = JSON.parse(textOf(await read!.execute("2", { path: "Review.md" })));
    expect(note).toMatchObject({ path: "Review.md", outLinks: [{ target: "Plan", path: "Plan.md" }], backlinks: [] });
    expect(JSON.parse(textOf(await read!.execute("3", { path: "Plan.md" }))).backlinks).toEqual(["Review.md"]);
  });

  it("reports problems as errors the agent can read", async () => {
    const [search, read] = tools();
    await expect(read!.execute("1", { path: "Nope.md" })).rejects.toThrow(/Note not found/);
    await expect(search!.execute("2", { since: "someday" })).rejects.toThrow(/Invalid date/);
  });
});
