import pino, { type Logger } from "pino";

export type { Logger };

export function createLogger(opts: { file?: string; stdout?: boolean } = {}): Logger {
  const streams = [
    ...(opts.stdout ? [{ stream: process.stdout }] : []),
    ...(opts.file ? [{ stream: pino.destination({ dest: opts.file, mkdir: true, sync: false }) }] : []),
  ];
  if (streams.length === 0) return pino({ level: "silent" });
  return pino({}, pino.multistream(streams));
}
