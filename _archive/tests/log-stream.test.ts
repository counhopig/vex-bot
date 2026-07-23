/**
 * Backend log streamer tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// The streamer reads whichever file getLogFile() points at; redirect it to a
// temp file we control so we can drive tailing and day-rollover deterministically.
let currentLogFile = "";
vi.mock("../src/utils/logger.js", () => ({
  getLogFile: () => currentLogFile,
}));

import { LogStreamer, type BackendLogEntry } from "../src/web/log-stream.js";

function pinoLine(fields: Record<string, unknown>): string {
  return JSON.stringify({ time: Date.now(), ...fields }) + "\n";
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("web/log-stream", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vex-logstream-"));
    currentLogFile = path.join(dir, "vex-2026-07-03.log");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("getBacklog", () => {
    it("parses recent lines and maps pino levels", () => {
      fs.writeFileSync(
        currentLogFile,
        [
          pinoLine({ level: 20, module: "weixin-client", msg: "Fetching messages" }),
          pinoLine({ level: 30, module: "config-handlers", msg: "Configuration saved" }),
          pinoLine({ level: 40, msg: "heads up" }),
          pinoLine({ level: 50, module: "gateway", msg: "boom" }),
        ].join(""),
      );

      const streamer = new LogStreamer(20);
      const backlog = streamer.getBacklog();

      expect(backlog.map((e) => e.level)).toEqual(["debug", "info", "warn", "error"]);
      expect(backlog[0]).toMatchObject({ module: "weixin-client", msg: "Fetching messages" });
      expect(backlog[3]).toMatchObject({ module: "gateway", msg: "boom" });
    });

    it("skips malformed lines and honors the limit", () => {
      fs.writeFileSync(
        currentLogFile,
        [
          pinoLine({ level: 30, msg: "a" }),
          "not json\n",
          pinoLine({ level: 30, msg: "b" }),
          pinoLine({ level: 30, msg: "c" }),
        ].join(""),
      );

      const streamer = new LogStreamer(20);
      const backlog = streamer.getBacklog(2);

      expect(backlog.map((e) => e.msg)).toEqual(["b", "c"]);
    });

    it("returns empty when the log file does not exist yet", () => {
      const streamer = new LogStreamer(20);
      expect(streamer.getBacklog()).toEqual([]);
    });
  });

  describe("tailing", () => {
    it("emits only lines appended after subscription", async () => {
      fs.writeFileSync(currentLogFile, pinoLine({ level: 30, msg: "before" }));

      const streamer = new LogStreamer(20);
      const received: BackendLogEntry[] = [];
      const unsubscribe = streamer.subscribe((e) => received.push(e));

      fs.appendFileSync(currentLogFile, pinoLine({ level: 30, module: "gateway", msg: "after" }));
      await tick(60);

      unsubscribe();
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ module: "gateway", msg: "after" });
    });

    it("handles a partial line split across polls", async () => {
      fs.writeFileSync(currentLogFile, "");
      const streamer = new LogStreamer(20);
      const received: BackendLogEntry[] = [];
      const unsubscribe = streamer.subscribe((e) => received.push(e));

      const line = pinoLine({ level: 30, msg: "chunked" });
      const half = Math.floor(line.length / 2);
      fs.appendFileSync(currentLogFile, line.slice(0, half));
      await tick(40);
      fs.appendFileSync(currentLogFile, line.slice(half));
      await tick(40);

      unsubscribe();
      expect(received.map((e) => e.msg)).toEqual(["chunked"]);
    });

    it("follows a day rollover to a new log file", async () => {
      fs.writeFileSync(currentLogFile, pinoLine({ level: 30, msg: "day one" }));
      const streamer = new LogStreamer(20);
      const received: BackendLogEntry[] = [];
      const unsubscribe = streamer.subscribe((e) => received.push(e));

      // Simulate midnight: getLogFile() now points at a fresh file.
      currentLogFile = path.join(dir, "vex-2026-07-04.log");
      fs.writeFileSync(currentLogFile, pinoLine({ level: 30, msg: "day two" }));
      await tick(60);

      unsubscribe();
      expect(received.map((e) => e.msg)).toEqual(["day two"]);
    });

    it("stops polling once the last subscriber leaves", async () => {
      fs.writeFileSync(currentLogFile, "");
      const streamer = new LogStreamer(20);
      const received: BackendLogEntry[] = [];
      const unsubscribe = streamer.subscribe((e) => received.push(e));
      unsubscribe();

      fs.appendFileSync(currentLogFile, pinoLine({ level: 30, msg: "ignored" }));
      await tick(60);

      expect(received).toHaveLength(0);
    });
  });
});
