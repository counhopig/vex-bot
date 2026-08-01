/**
 * Logger utility — pino-based structured logging.
 *
 * Ported from the archive's utils/logger.ts. Defaults to stderr JSON output
 * at info level; `createLogger` can fan out to stdout + a daily JSON file
 * (`~/.vex/logs/vex-YYYY-MM-DD.log`), which the web control panel's LogStreamer
 * tails for live backend logs.
 */

import pino from "pino";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export type LogLevel = "debug" | "info" | "warn" | "error";

let rootLogger: pino.Logger | null = null;

/** The directory where daily log files are written. */
export function getLogDir(): string {
  return join(homedir(), ".vex", "logs");
}

/** The current daily log file path (date-encoded, so it rolls over at midnight). */
export function getLogFile(): string {
  const logDir = getLogDir();
  const date = new Date().toISOString().split("T")[0];
  return join(logDir, `vex-${date}.log`);
}

/** Ensure the log directory exists. */
function ensureLogDir(): void {
  const logDir = getLogDir();
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }
}

/** Create a pino logger with optional pretty console + daily file output. */
export function createLogger(options: {
  level?: LogLevel;
  name?: string;
  pretty?: boolean;
  logToFile?: boolean;
}): pino.Logger {
  const {
    level = "info",
    name = "vex",
    pretty = false,
    logToFile = true,
  } = options;

  // If logging to file, ensure directory exists
  if (logToFile) {
    ensureLogDir();
  }

  // Configure multi-destination output
  const targets: pino.TransportTargetOptions[] = [];

  // Console output (with formatting)
  if (pretty) {
    targets.push({
      target: "pino-pretty",
      level,
      options: {
        colorize: true,
        translateTime: "SYS:standard",
        // Surface the child-logger module inline; pino-pretty colorizes the level label.
        ignore: "pid,hostname,module",
        messageFormat: "{if module}[{module}] {end}{msg}",
      },
    });
  } else {
    targets.push({
      target: "pino/file",
      level,
      options: { destination: 1 }, // stdout
    });
  }

  // File output
  if (logToFile) {
    targets.push({
      target: "pino/file",
      level,
      options: { destination: getLogFile() },
    });
  }

  const logger = pino({
    name,
    level,
    transport: {
      targets,
    },
  });

  return logger;
}

export function getLogger(): pino.Logger {
  if (!rootLogger) {
    rootLogger = createLogger({
      level: "info",
      pretty: false,
    });
  }
  return rootLogger;
}

export function setLogger(logger: pino.Logger): void {
  rootLogger = logger;
}

/** Get a namespaced child logger. See AGENTS.md "Logger via pino" convention. */
export function getChildLogger(name: string): pino.Logger {
  return getLogger().child({ module: name });
}

export type { pino as Logger };
