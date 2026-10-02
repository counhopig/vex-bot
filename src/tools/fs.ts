import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { displayPath, resolveToolPath } from "./paths.js";

const ReadParams = Type.Object({
  path: Type.String({ description: "文件路径，相对路径基于工作区" }),
  offset: Type.Optional(Type.Integer({ minimum: 1, description: "起始行号（从 1 开始）" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: "最多读取的行数，默认 2000" })),
});

export function createReadTool(workspace: string): AgentTool<typeof ReadParams> {
  return {
    name: "read",
    label: "读取文件",
    description: "读取文本文件，每行前带行号。",
    parameters: ReadParams,
    async execute(_id, { path, offset = 1, limit = 2000 }) {
      const abs = resolveToolPath(workspace, path);
      const lines = (await readFile(abs, "utf8")).split("\n");
      const start = offset - 1;
      const body = lines
        .slice(start, start + limit)
        .map((line, i) => `${offset + i}\t${line}`)
        .join("\n");
      const more = start + limit < lines.length ? `\n…（共 ${lines.length} 行，用 offset 继续读取）` : "";
      return { content: [{ type: "text", text: body + more }], details: { path: abs } };
    },
  };
}

const WriteParams = Type.Object({
  path: Type.String({ description: "文件路径，相对路径基于工作区" }),
  content: Type.String({ description: "完整文件内容" }),
});

export function createWriteTool(workspace: string): AgentTool<typeof WriteParams> {
  return {
    name: "write",
    label: "写入文件",
    description: "写入完整文件内容，文件存在时覆盖，父目录不存在时自动创建。",
    parameters: WriteParams,
    async execute(_id, { path, content }) {
      const abs = resolveToolPath(workspace, path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
      const bytes = Buffer.byteLength(content, "utf8");
      return {
        content: [{ type: "text", text: `已写入 ${displayPath(workspace, abs)}（${bytes} 字节）` }],
        details: { path: abs },
      };
    },
  };
}

const EditParams = Type.Object({
  path: Type.String({ description: "文件路径，相对路径基于工作区" }),
  oldText: Type.String({ description: "要替换的原文，必须与文件内容完全一致" }),
  newText: Type.String({ description: "替换后的文本" }),
  replaceAll: Type.Optional(Type.Boolean({ description: "替换所有出现，默认只允许唯一匹配" })),
});

export function createEditTool(workspace: string): AgentTool<typeof EditParams> {
  return {
    name: "edit",
    label: "编辑文件",
    description: "把文件中的 oldText 精确替换为 newText。oldText 必须唯一出现，除非设置 replaceAll。",
    parameters: EditParams,
    async execute(_id, { path, oldText, newText, replaceAll = false }) {
      if (oldText === "") throw new Error("oldText 不能为空");
      const abs = resolveToolPath(workspace, path);
      const original = await readFile(abs, "utf8");
      const count = original.split(oldText).length - 1;
      if (count === 0) throw new Error(`在 ${displayPath(workspace, abs)} 中没有找到 oldText`);
      if (count > 1 && !replaceAll) {
        throw new Error(`oldText 出现了 ${count} 次，请提供更多上下文使其唯一，或设置 replaceAll`);
      }
      const updated = replaceAll ? original.split(oldText).join(newText) : original.replace(oldText, () => newText);
      await writeFile(abs, updated, "utf8");
      return {
        content: [{ type: "text", text: `已修改 ${displayPath(workspace, abs)}（替换 ${replaceAll ? count : 1} 处）` }],
        details: { path: abs },
      };
    },
  };
}
