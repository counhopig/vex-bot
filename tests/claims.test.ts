import { expect, it } from "vitest";
import { describeOutcomes, unsupportedClaim, type EvidenceProfiles } from "../src/context/claims.js";

const profiles: EvidenceProfiles = {
  fetch_page: { supports: { read: (receipt) => receipt?.ok === true }, linkArgument: true, describe: (receipt) => `fetched ${String(receipt.requestedUrl)}` },
  run_job: { supports: { executed: true } },
};
const call = (tool: string, args: unknown, error: boolean, receipt?: Record<string, unknown>) => ({ tool, arguments: JSON.stringify(args), error, ...(receipt ? { receipt } : {}) });

it("checks claims only against the tools a profile says can support them", () => {
  const turn = { urls: [], evidence: [call("run_job", {}, false)] };
  expect(unsupportedClaim("The job ran.", turn, profiles)).toBe(false);
  expect(unsupportedClaim("The page was read.", turn, profiles)).toBe(true);
  expect(unsupportedClaim("The job ran.", turn, {})).toBe(true);
  expect(unsupportedClaim("I'll run it now; it was not read.", turn, profiles)).toBe(false);
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
