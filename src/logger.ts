import pino, { type Logger } from "pino";

export type { Logger };

const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"];

/** `VEX_LOG_LEVEL` picks the level; `debug` adds message sizes, tool results and ignored traffic. */
function levelFromEnv(): string {
  const value = process.env.VEX_LOG_LEVEL?.trim().toLowerCase();
  return value && LEVELS.includes(value) ? value : "info";
}

export function createLogger(opts: { file?: string; stdout?: boolean; level?: string } = {}): Logger {
  const streams = [
    ...(opts.stdout ? [{ stream: process.stdout }] : []),
    ...(opts.file ? [{ stream: pino.destination({ dest: opts.file, mkdir: true, sync: false }) }] : []),
  ];
  if (streams.length === 0) return pino({ level: "silent" });
  return pino({ level: opts.level ?? levelFromEnv() }, pino.multistream(streams));
}
