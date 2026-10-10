import { expect, it } from "vitest";
import { describeOutcomes, unsupportedClaim, type EvidenceProfiles } from "../src/context/claims.js";

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
