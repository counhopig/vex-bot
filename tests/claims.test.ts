import { expect, it } from "vitest";
import { describeOutcomes, mentionsLink, unsupportedClaim, type EvidenceProfiles } from "../src/context/claims.js";
import { TOOL_EVIDENCE } from "./helpers/evidence.js";

const profiles: EvidenceProfiles = {
  fetch_page: { supports: { read: (receipt) => receipt?.ok === true }, linkArgument: true, describe: (receipt) => `fetched ${String(receipt.requestedUrl)}` },
  run_job: { supports: { compiled: true } },
};
const call = (tool: string, args: unknown, error: boolean, receipt?: Record<string, unknown>) => ({ tool, arguments: JSON.stringify(args), error, ...(receipt ? { receipt } : {}) });

it("checks link claims only against the tools a profile says can support them", () => {
  const turn = { urls: ["https://example.test/a"], evidence: [call("run_job", {}, false)] };
  expect(unsupportedClaim("The wiki was compiled.", turn, profiles)).toBe(false);
  expect(unsupportedClaim("The page was read.", turn, profiles)).toBe(true);
  expect(unsupportedClaim("The wiki was compiled.", turn, {})).toBe(true);
  // Without links, a call that could support the claim makes the claim checkable.
  const failed = { urls: [], evidence: [call("fetch_page", { url: "https://x.test" }, false, { ok: false })] };
  expect(unsupportedClaim("The page was read.", failed, profiles)).toBe(true);
  expect(unsupportedClaim("I'll compile it now; it was not read.", turn, profiles)).toBe(false);
});

it("treats wording alone as no evidence either way", () => {
  // Without the owner's links there is no receipt-backed operation to check.
  const plain = { urls: [], evidence: [] };
  expect(unsupportedClaim("文件已经保存好了。", plain, profiles)).toBe(false);
  expect(unsupportedClaim("I sent the message.", plain, profiles)).toBe(false);
  // Instructions and other kinds of operation are not claims about the owner's links.
  const linked = { urls: ["https://example.test/a"], evidence: [] };
  expect(unsupportedClaim("Read the README first.", linked, profiles)).toBe(false);
  expect(unsupportedClaim("I sent the message and ran the job.", linked, profiles)).toBe(false);
});

it("needs the receipt of the call for each named link", () => {
  const a = "https://example.test/a";
  const b = "https://example.test/b";
  const turn = { urls: [a, b], evidence: [call("fetch_page", { url: a }, false, { ok: true, requestedUrl: a }), call("fetch_page", { url: b }, false, { ok: false, requestedUrl: b })] };
  expect(unsupportedClaim(`I read ${a}.`, turn, profiles)).toBe(false);
  expect(unsupportedClaim(`I read ${b}.`, turn, profiles)).toBe(true);
  expect(unsupportedClaim("Both were read.", turn, profiles)).toBe(true);
  expect(describeOutcomes(turn, profiles)).toEqual([`fetched ${a}`, `fetched ${b}`]);
});

it("binds a link claim to a call on exactly that link", () => {
  const page = "https://example.test/article";
  const other = "https://example.test/article-other";
  const receipt = (url: string) => ({ version: 1, requestedUrl: url, canonicalUrl: url, sourceAvailable: true });
  // Reading a local file does not prove reading the owner's web page.
  const local = { urls: [page], evidence: [call("read", { path: "README.md" }, false)] };
  expect(unsupportedClaim("我已读取你提供的网页。", local, TOOL_EVIDENCE)).toBe(true);
  expect(unsupportedClaim(`I read ${page}.`, local, TOOL_EVIDENCE)).toBe(true);
  // A link that merely starts with the requested one is a different link.
  const prefixed = { urls: [page], evidence: [call("web_fetch", { url: other }, false, receipt(other))] };
  expect(unsupportedClaim(`I read ${page}.`, prefixed, TOOL_EVIDENCE)).toBe(true);
  const exact = { urls: [page], evidence: [call("web_fetch", { url: page }, false, receipt(page))] };
  expect(unsupportedClaim(`I read ${page}.`, exact, TOOL_EVIDENCE)).toBe(false);
  // Without links, a local read still supports a read claim about that file.
  expect(unsupportedClaim("I read the README.", { urls: [], evidence: [call("read", { path: "README.md" }, false)] }, TOOL_EVIDENCE)).toBe(false);
});

it("matches a mentioned link as a whole URL", () => {
  expect(mentionsLink({ command: "curl -s https://example.test/article-other" }, "https://example.test/article")).toBe(false);
  expect(mentionsLink({ command: "curl -s 'https://example.test/article'" }, "https://example.test/article")).toBe(true);
});

it("binds each clause's operation to the links that clause names", () => {
  const a = "https://example.test/a";
  const b = "https://example.test/b";
  const read = (url: string, ok: boolean) => call("web_fetch", { url }, false, { version: 1, requestedUrl: url, sourceAvailable: ok });
  const turn = { urls: [a, b], evidence: [read(a, true), read(b, false)] };
  // Honest replies about one success and one failure are supported, in English and Chinese.
  expect(unsupportedClaim(`I read ${a}. I did not read ${b}.`, turn, TOOL_EVIDENCE)).toBe(false);
  expect(unsupportedClaim(`I read ${a}, but reading ${b} failed.`, turn, TOOL_EVIDENCE)).toBe(false);
  expect(unsupportedClaim(`我已读取 ${a}；${b} 读取失败。`, turn, TOOL_EVIDENCE)).toBe(false);
  expect(unsupportedClaim(`已读取 ${a}，${b} 未能读取。`, turn, TOOL_EVIDENCE)).toBe(false);
  // Claiming the failed link, or both links without naming them, is still unsupported.
  expect(unsupportedClaim(`I read ${a}. I read ${b}.`, turn, TOOL_EVIDENCE)).toBe(true);
  expect(unsupportedClaim(`我已读取 ${a}；也已读取 ${b}。`, turn, TOOL_EVIDENCE)).toBe(true);
  expect(unsupportedClaim("Both links were read.", turn, TOOL_EVIDENCE)).toBe(true);
});
