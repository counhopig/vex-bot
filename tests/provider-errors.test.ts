import { describe, expect, it } from "vitest";
import { providerErrorCause, providerFailureMessage } from "../src/providers/errors.js";

describe("provider error causes", () => {
  it("names common provider failures without repeating the raw text", () => {
    expect(providerErrorCause('529 {"type":"error","error":{"type":"overloaded_error","message":"当前服务集群负载较高"},"request_id":"0725f8578635a82dbfe1913b5a7c0df9"}')).toBe("the model service is overloaded (529)");
    expect(providerErrorCause("429 Too Many Requests")).toBe("the model service is rate limiting requests (429)");
    expect(providerErrorCause("HTTP 401: invalid key sk-secret")).toBe("the model service rejected the API key");
    expect(providerErrorCause("502 Bad Gateway")).toBe("the model service returned an error (502)");
    expect(providerErrorCause("fetch failed: ECONNRESET")).toBe("the model service could not be reached");
    expect(providerErrorCause("provider secret detail")).toBeUndefined();
    expect(providerErrorCause(undefined)).toBeUndefined();
  });

  it("adds a recognised cause to the owner-facing message", () => {
    expect(providerFailureMessage("529 overloaded")).toBe("Provider generation failed before a checked reply was available: the model service is overloaded (529).");
    expect(providerFailureMessage("boom")).toBe("Provider generation failed before a checked reply was available.");
  });
});
