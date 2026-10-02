import { describe, expect, it, vi } from "vitest";
import { EventBus, type VexEvent } from "../src/core/events.js";

describe("EventBus", () => {
  it("delivers events to subscribers until they unsubscribe", () => {
    const bus = new EventBus();
    const seen: VexEvent[] = [];
    const off = bus.on((e) => seen.push(e));
    bus.emit({ type: "sessions_changed" });
    off();
    bus.emit({ type: "approvals_changed" });
    expect(seen).toEqual([{ type: "sessions_changed" }]);
  });

  it("isolates a throwing listener", () => {
    const onError = vi.fn();
    const bus = new EventBus(onError);
    const good = vi.fn();
    bus.on(() => { throw new Error("bad"); });
    bus.on(good);
    bus.emit({ type: "sessions_changed" });
    expect(good).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "bad" }));
  });
});
