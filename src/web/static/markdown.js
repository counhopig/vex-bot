// @ts-check

import { element } from "./ui.js";


const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function startsBlock(line, next) {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || /^\s{0,3}>/.test(line) || LIST_ITEM.test(line)
    || (line.includes("|") && next !== undefined && TABLE_DIVIDER.test(next) && next.includes("-"));
}

function splitRow(line) {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|")) row = row.slice(0, -1);
  return row.split("|").map((cell) => cell.trim());
}

function parseList(lines, start) {
  const first = LIST_ITEM.exec(lines[start]);
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items = [];
  let i = start;
  while (i < lines.length) {
    const match = LIST_ITEM.exec(lines[i]);
    if (!match || match[1].length < baseIndent || (match[1].length === baseIndent && /\d/.test(match[2]) !== ordered)) break;
    if (match[1].length > baseIndent) {
      const nested = parseList(lines, i);
      const last = items[items.length - 1];
      if (last) last.blocks.push(nested.block);
      i = nested.next;
      continue;
    }
    const item = { inline: parseInline(match[3]), blocks: [] };
    items.push(item);
    i++;
    while (i < lines.length && lines[i].trim() && !LIST_ITEM.test(lines[i]) && /^\s+/.test(lines[i])) {
      item.inline.push({ t: "br" }, ...parseInline(lines[i].trim()));
      i++;
    }
  }
  return { block: { type: "list", ordered, items }, next: i };
}

function parseMarkdown(text) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const body = [];
      i++;
      while (i < lines.length && !(lines[i].trim().startsWith(marker[0].repeat(marker.length)) && lines[i].trim().replace(new RegExp(`^${marker[0]}+`), "") === "")) body.push(lines[i++]);
      i++;
      blocks.push({ type: "code", lang: fence[2], text: body.join("\n") });
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const heading = HEADING.exec(line);
    if (heading) { blocks.push({ type: "heading", level: heading[1].length, inline: parseInline(heading[2]) }); i++; continue; }
    if (RULE.test(line)) { blocks.push({ type: "rule" }); i++; continue; }
    if (/^\s{0,3}>/.test(line)) {
      const quoted = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) quoted.push(lines[i++].replace(/^\s{0,3}> ?/, ""));
      blocks.push({ type: "quote", blocks: parseMarkdown(quoted.join("\n")) });
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const list = parseList(lines, i);
      blocks.push(list.block);
      i = list.next;
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const head = splitRow(line);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) rows.push(splitRow(lines[i++]));
      blocks.push({ type: "table", head: head.map(parseInline), rows: rows.map((row) => row.map(parseInline)) });
      continue;
    }
    const paragraph = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1])) paragraph.push(lines[i++]);
    const inline = [];
    paragraph.forEach((part, index) => { if (index) inline.push({ t: "br" }); inline.push(...parseInline(part.trim())); });
    blocks.push({ type: "paragraph", inline });
  }
  return blocks;
}

/** @type {[string, RegExp][]} */
const INLINE_PATTERNS = [
  ["code", /`([^`\n]+)`/],
  ["link", /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/],
  ["bold", /\*\*(?=\S)([\s\S]*?\S)\*\*/],
  ["strike", /~~(?=\S)([\s\S]*?\S)~~/],
  ["italic", /(?<![*\w])\*(?=\S)([^*\n]*?\S)\*(?!\*)/],
  ["italic", /(?<!\w)_(?=\S)([^_\n]*?\S)_(?!\w)/],
  ["url", /https?:\/\/[^\s<>()]+[^\s<>().,;:!?，。；：！？）」』]/],
];

function parseInline(text) {
  const nodes = [];
  let rest = text;
  while (rest) {
    let best;
    for (const [kind, pattern] of INLINE_PATTERNS) {
      const match = pattern.exec(rest);
      if (match && (!best || match.index < best.match.index)) best = { kind, match };
    }
    if (!best) { nodes.push({ t: "text", v: rest }); break; }
    const { kind, match } = best;
    if (match.index > 0) nodes.push({ t: "text", v: rest.slice(0, match.index) });
    if (kind === "code") nodes.push({ t: "code", v: match[1] });
    else if (kind === "link") nodes.push({ t: "link", href: match[2], c: parseInline(match[1]) });
    else if (kind === "url") nodes.push({ t: "link", href: match[0], c: [{ t: "text", v: match[0] }] });
    else nodes.push({ t: kind, c: parseInline(match[1]) });
    rest = rest.slice(match.index + match[0].length);
  }
  return nodes;
}

function renderInline(parent, nodes) {
  for (const node of nodes) {
    switch (node.t) {
      case "text": parent.append(document.createTextNode(node.v)); break;
      case "br": parent.append(document.createElement("br")); break;
      case "code": parent.append(element("code", "", node.v)); break;
      case "link": {
        const a = element("a");
        a.href = node.href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        renderInline(a, node.c);
        parent.append(a);
        break;
      }
      default: {
        const tag = { bold: "strong", italic: "em", strike: "del" }[node.t];
        const el = element(tag);
        renderInline(el, node.c);
        parent.append(el);
      }
    }
  }
}

function copyText(button, text) {
  const done = () => {
    button.textContent = "Copied";
    setTimeout(() => { button.textContent = "Copy"; }, 1500);
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, () => {});
}

function renderBlocks(parent, blocks) {
  for (const block of blocks) {
    switch (block.type) {
      case "paragraph": { const p = element("p"); renderInline(p, block.inline); parent.append(p); break; }
      case "heading": { const h = element(`h${block.level}`); renderInline(h, block.inline); parent.append(h); break; }
      case "rule": parent.append(element("hr")); break;
      case "quote": { const q = element("blockquote"); renderBlocks(q, block.blocks); parent.append(q); break; }
      case "list": {
        const list = element(block.ordered ? "ol" : "ul");
        for (const item of block.items) {
          const li = element("li");
          renderInline(li, item.inline);
          renderBlocks(li, item.blocks);
          list.append(li);
        }
        parent.append(list);
        break;
      }
      case "code": {
        const wrap = element("div", "code");
        const head = element("div", "code-head");
        head.append(element("span", "", block.lang || "code"));
        const copy = element("button", "", "Copy");
        copy.type = "button";
        copy.addEventListener("click", () => copyText(copy, block.text));
        head.append(copy);
        const pre = element("pre");
        pre.append(element("code", "", block.text));
        wrap.append(head, pre);
        parent.append(wrap);
        break;
      }
      case "table": {
        const wrap = element("div", "table-wrap");
        const table = element("table");
        const thead = element("thead");
        const headRow = element("tr");
        for (const cell of block.head) { const th = element("th"); renderInline(th, cell); headRow.append(th); }
        thead.append(headRow);
        const tbody = element("tbody");
        for (const row of block.rows) {
          const tr = element("tr");
          for (const cell of row) { const td = element("td"); renderInline(td, cell); tr.append(td); }
          tbody.append(tr);
        }
        table.append(thead, tbody);
        wrap.append(table);
        parent.append(wrap);
        break;
      }
    }
  }
}

/** Renders `text` as safe Markdown into `target`, replacing its children. */
export function renderMarkdown(target, text) {
  target.replaceChildren();
  renderBlocks(target, parseMarkdown(text));
}
