import { mapLimited } from "./shared.mjs";

const SINGLE_LIMIT = 12_000;
const CHUNK_SIZE = 8_000;
const CONCURRENCY = 4;

export async function summarizeText(text, kind, ask) {
  const requirements = "Requirements:\n1. First give an overview in 2-3 sentences\n2. Then list 3-5 key points\n3. Stay objective; add no opinions of your own\n4. Write in the same language as the content";
  if (text.length <= SINGLE_LIMIT) return ask(`Summarize the ${kind} below and extract the core points.\n\n${kind}:\n${text}\n\n${requirements}`);

  const chunks = [];
  for (let start = 0; start < text.length; start += CHUNK_SIZE) chunks.push(text.slice(start, start + CHUNK_SIZE));
  const parts = (await mapLimited(chunks, CONCURRENCY, (chunk, index) =>
    ask(`This is part ${index + 1} of ${chunks.length} of the ${kind}. Extract its key points:\n\n${chunk}\n\nRequirement: output only a list of points, with no concluding statements.`),
  )).map((part) => part.trim()).filter(Boolean);
  if (!parts.length) throw new Error("The model returned nothing");
  const merged = parts.map((part, index) => `[Points from part ${index + 1}]\n${part}`).join("\n\n");
  return ask(`Below are the points extracted from each part of the ${kind}. Combine them into one complete summary:\n\n${merged}\n\n${requirements}`);
}
