import { expect, it } from "vitest";
import { TurnReply } from "../src/channels/turnReply.js";

it("keeps the turn's final texts and errors, not tool-call narration", () => {
  const turn = new TurnReply();
  turn.add({ kind: "assistant_message", text: "Looking it up", stopReason: "toolUse", timestamp: 1 });
  turn.add({ kind: "assistant_message", text: "Here it is", stopReason: "stop", timestamp: 2 });
  expect(turn.text).toBe("Here it is");
  expect(turn.status).toBe("ok");
  turn.add({ kind: "error", message: "offline" });
  expect(turn.text).toBe("Here it is\n\noffline");
  expect(turn.status).toBe("error");
});

it("keeps an interruption as the outcome even when an error follows", () => {
  const turn = new TurnReply();
  turn.add({ kind: "assistant_message", text: "", stopReason: "aborted", timestamp: 1 });
  turn.add({ kind: "error", message: "late failure" });
  expect(turn.status).toBe("interrupted");
});
