import { describe, expect, it, vi } from "vitest";
import type { Persona } from "../src/persona/index.js";
import { createOutreachCheck } from "../src/persona/outreach.js";
import { createLogger } from "../src/logger.js";

function fixture(options: { want?: boolean; available?: boolean; delivered?: boolean; reply?: string; answered?: boolean } = {}) {
  let inbound = 0;
  const persona = { shouldOutreach: vi.fn(() => options.want ?? true), outreachPrompt: vi.fn(() => "say hi"), outreachSent: vi.fn(), save: vi.fn(async () => {}) };
  const session = {
    busy: false,
    successfulReply: undefined as string | undefined,
    runToIdle: vi.fn(async () => { session.successfulReply = options.reply ?? "hi"; if (options.answered) inbound++; }),
  };
  const check = createOutreachCheck({
    persona: persona as unknown as Persona,
    wechat: () => ({ available: options.available ?? true, replyDelivered: async () => options.delivered ?? true }),
    session: async () => session,
    inbound: () => inbound,
    log: createLogger(),
  });
  return { check, persona, session };
}

describe("outreach check", () => {
  it("runs one proactive chat and records it once its reply reached the owner", async () => {
    const { check, persona, session } = fixture({ answered: true });
    await check(new AbortController().signal);
    expect(session.runToIdle).toHaveBeenCalledWith("say hi", "proactive chat", expect.any(AbortSignal));
    expect(persona.outreachSent).toHaveBeenCalledWith(true);
  });

  it("does not count a chat whose reply was not delivered", async () => {
    const { check, persona } = fixture({ delivered: false });
    await check(new AbortController().signal);
    expect(persona.outreachSent).not.toHaveBeenCalled();
  });

  it("starts nothing when WeChat cannot send or the persona does not want to talk", async () => {
    for (const options of [{ available: false }, { want: false }]) {
      const { check, session } = fixture(options);
      await check(new AbortController().signal);
      expect(session.runToIdle).not.toHaveBeenCalled();
    }
  });
});
