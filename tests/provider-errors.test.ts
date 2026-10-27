import { describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { providerErrorCause, providerFailureMessage, withProviderFailures } from "../src/providers/errors.js";
import { createFaux, fauxStreamFn } from "./helpers/faux.js";

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
    expect(providerFailureMessage("529 overloaded")).toBe("Provider generation failed: the model service is overloaded (529).");
    expect(providerFailureMessage("boom")).toBe("Provider generation failed.");
  });
});

describe("provider failure stream", () => {
  const context = { messages: [{ role: "user" as const, content: "hello", timestamp: 1 }] } as TranscriptContext;

  it("logs the raw error once and shows the owner only its cause", async () => {
    const faux = createFaux();
    faux.setResponses([fauxAssistantMessage("partial prose", { stopReason: "error", errorMessage: "HTTP 401: invalid key sk-secret" })]);
    const log = vi.fn();
    const output = await withProviderFailures(fauxStreamFn(faux), log)(faux.getModel(), context, undefined);
    for await (const _event of output) { /* drain */ }
    const message = await output.result();
    expect(message.errorMessage).toBe("Provider generation failed: the model service rejected the API key.");
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith("HTTP 401: invalid key sk-secret");
  });

  it("passes kept errors and successful replies through unchanged", async () => {
    const faux = createFaux();
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "LOCAL_MARKER" }), fauxAssistantMessage("fine")]);
    const log = vi.fn();
    const stream = withProviderFailures(fauxStreamFn(faux), log, (message) => message === "LOCAL_MARKER");
    expect((await (await stream(faux.getModel(), context, undefined)).result()).errorMessage).toBe("LOCAL_MARKER");
    expect((await (await stream(faux.getModel(), context, undefined)).result()).content).toMatchObject([{ type: "text", text: "fine" }]);
    expect(log).not.toHaveBeenCalled();
  });
});
