const SINGLE_LIMIT = 12_000;
const CHUNK_SIZE = 8_000;
const CONCURRENCY = 4;

async function mapLimited(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index], index);
    }
  }));
  return results;
}

export async function summarizeText(text, kind, ask) {
  const requirements = "要求：\n1. 先用 2-3 句话给出整体概要\n2. 再列出 3-5 个关键要点\n3. 保持客观中立，不添加个人评价\n4. 使用中文输出";
  if (text.length <= SINGLE_LIMIT) return ask(`请总结下面的${kind}，提取核心要点。\n\n${kind}：\n${text}\n\n${requirements}`);

  const chunks = [];
  for (let start = 0; start < text.length; start += CHUNK_SIZE) chunks.push(text.slice(start, start + CHUNK_SIZE));
  const parts = (await mapLimited(chunks, CONCURRENCY, (chunk, index) =>
    ask(`这是${kind}的第 ${index + 1}/${chunks.length} 部分，请提取其中的关键信息要点：\n\n${chunk}\n\n要求：只输出要点列表，不要输出总结性语句。`),
  )).map((part) => part.trim()).filter(Boolean);
  if (!parts.length) throw new Error("模型没有返回内容");
  const merged = parts.map((part, index) => `【第 ${index + 1} 部分要点】\n${part}`).join("\n\n");
  return ask(`以下是${kind}各分段提取的要点，请整合为一份完整的总结：\n\n${merged}\n\n${requirements}`);
}
