import { describe, it, expect, afterEach } from "vitest";
import { createBashTool } from "../src/tools/builtin/bash.js";
import { createProcessTool } from "../src/tools/builtin/process-tool.js";
import { listRunningSessions, listFinishedSessions, deleteSession } from "../src/tools/builtin/process-registry.js";

// Parse the JSON payload a tool result carries in its text content.
function payload(result: { content: Array<{ text?: string }> }): any {
  return JSON.parse(result.content.map((c) => c.text ?? "").join(""));
}

describe("process tool owner isolation", () => {
  afterEach(() => {
    for (const s of [...listRunningSessions(), ...listFinishedSessions()]) deleteSession(s.id);
  });

  async function startBackground(owner: string): Promise<string> {
    const bash = createBashTool({ owner });
    const res = await bash.execute("b", { command: "sleep 30", run_in_background: true }, undefined);
    return payload(res).session_id as string;
  }

  it("does not list another owner's sessions", async () => {
    const aId = await startBackground("userA");
    await startBackground("userB");

    const procA = createProcessTool("userA");
    const list = payload(await procA.execute("l", { action: "list" }, undefined));
    const ids = (list.processes ?? []).map((p: any) => p.session_id);

    expect(ids).toContain(aId);
    expect(ids.length).toBe(1);
  });

  it("cannot poll or kill another owner's session", async () => {
    const aId = await startBackground("userA");
    const procB = createProcessTool("userB");

    const poll = payload(await procB.execute("p", { action: "poll", session_id: aId }, undefined));
    expect(poll.status).toBe("error");

    const kill = payload(await procB.execute("k", { action: "kill", session_id: aId }, undefined));
    expect(kill.status).toBe("error");
  });

  it("lets the owning tool poll its own session", async () => {
    const aId = await startBackground("userA");
    const procA = createProcessTool("userA");

    const poll = payload(await procA.execute("p", { action: "poll", session_id: aId }, undefined));
    expect(poll.status).toBe("success");
    expect(poll.session_id).toBe(aId);
  });
});
