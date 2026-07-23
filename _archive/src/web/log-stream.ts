/**
 * Backend log streamer for the control panel.
 *
 * The app writes structured pino logs (one JSON object per line) to the daily
 * log file returned by getLogFile(). This module tails that file and hands newly
 * appended entries to subscribers so the control panel can display real backend
 * logs in real time. We tail the file (rather than hooking pino) because pino's
 * transport targets run in a worker thread and cannot be intercepted in-process.
 */

import * as fs from "fs";
import { getLogFile, type LogLevel } from "../utils/logger.js";

/** A normalized log line delivered to the control panel. */
export interface BackendLogEntry {
  /** Epoch milliseconds. */
  time: number;
  level: LogLevel;
  /** Child logger module name, when present. */
  module?: string;
  msg: string;
}

/** Map pino numeric levels to our coarse LogLevel buckets. */
function mapLevel(level: number): LogLevel {
  if (level >= 50) return "error";
  if (level >= 40) return "warn";
  if (level >= 30) return "info";
  return "debug";
}

/** Parse a single pino JSON log line; returns null for blanks/malformed lines. */
function parseLine(line: string): BackendLogEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof obj !== "object" || obj === null) return null;
    const levelNum = typeof obj.level === "number" ? obj.level : 30;
    return {
      time: typeof obj.time === "number" ? obj.time : Date.now(),
      level: mapLevel(levelNum),
      module: typeof obj.module === "string" ? obj.module : undefined,
      msg: typeof obj.msg === "string" ? obj.msg : "",
    };
  } catch {
    return null;
  }
}

type Listener = (entry: BackendLogEntry) => void;

/**
 * Tails the daily log file and fans new entries out to subscribers. Polling only
 * runs while at least one subscriber is attached.
 */
export class LogStreamer {
  private offset = 0;
  private currentFile = "";
  /** Carries a trailing partial line between polls. */
  private partial = "";
  private timer: NodeJS.Timeout | null = null;
  private listeners = new Set<Listener>();
  private readonly pollMs: number;

  constructor(pollMs = 1000) {
    this.pollMs = pollMs;
  }

  /** Attach a listener; returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => this.unsubscribe(listener);
  }

  unsubscribe(listener: Listener): void {
    if (this.listeners.delete(listener) && this.listeners.size === 0) {
      this.stop();
    }
  }

  /** Read the tail of the current log file for an initial backlog. */
  getBacklog(limit = 200, maxBytes = 262_144): BackendLogEntry[] {
    const file = getLogFile();
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return [];
    }
    const start = Math.max(0, size - maxBytes);
    let text: string;
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString("utf-8");
    } finally {
      fs.closeSync(fd);
    }
    // Drop a leading partial line when we didn't read from the start.
    if (start > 0) {
      const nl = text.indexOf("\n");
      if (nl >= 0) text = text.slice(nl + 1);
    }
    const entries: BackendLogEntry[] = [];
    for (const line of text.split("\n")) {
      const entry = parseLine(line);
      if (entry) entries.push(entry);
    }
    return entries.slice(-limit);
  }

  private start(): void {
    this.currentFile = getLogFile();
    // Begin at end-of-file so subscribers only receive new lines (backlog is
    // delivered separately on subscribe).
    try {
      this.offset = fs.statSync(this.currentFile).size;
    } catch {
      this.offset = 0;
    }
    this.partial = "";
    this.timer = setInterval(() => this.poll(), this.pollMs);
    this.timer.unref?.();
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private poll(): void {
    const file = getLogFile();
    // Day rollover: the filename encodes the date, so reset when it changes.
    if (file !== this.currentFile) {
      this.currentFile = file;
      this.offset = 0;
      this.partial = "";
    }

    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return;
    }
    // File was truncated or rotated under us.
    if (size < this.offset) {
      this.offset = 0;
      this.partial = "";
    }
    if (size === this.offset) return;

    let text: string;
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(size - this.offset);
      fs.readSync(fd, buf, 0, buf.length, this.offset);
      text = buf.toString("utf-8");
    } catch {
      return;
    } finally {
      fs.closeSync(fd);
    }
    this.offset = size;

    this.partial += text;
    const lines = this.partial.split("\n");
    this.partial = lines.pop() ?? "";
    for (const line of lines) {
      const entry = parseLine(line);
      if (entry) this.emit(entry);
    }
  }

  private emit(entry: BackendLogEntry): void {
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        // A failing subscriber must not break the fan-out.
      }
    }
  }
}
