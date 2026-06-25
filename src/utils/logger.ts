/**
 * Logger utility
 */

import pino, { type Logger as PinoLogger } from "pino";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

export type LogLevel = "debug" | "info" | "warn" | "error";

let globalLogger: PinoLogger | null = null;

/** Get the log directory */
export function getLogDir(): string {
  // Prefer environment variable
  if (process.env.VEX_LOG_DIR) {
    return process.env.VEX_LOG_DIR;
  }
  // Default to user home directory
  return join(homedir(), ".vex", "logs");
}

/** Get the current log file path */
export function getLogFile(): string {
  const logDir = getLogDir();
  const date = new Date().toISOString().split("T")[0];
  return join(logDir, `vex-${date}.log`);
}

/** Ensure the log directory exists */
function ensureLogDir(): void {
  const logDir = getLogDir();
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }
}

/** Create a logger */
export function createLogger(options: {
  level?: LogLevel;
  name?: string;
  pretty?: boolean;
  logToFile?: boolean;
}): PinoLogger {
  const {
    level = "info",
    name = "vex",
    pretty = process.env.NODE_ENV !== "production",
    logToFile = true
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
        ignore: "pid,hostname",
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

/** Get the global logger */
export function getLogger(): PinoLogger {
  if (!globalLogger) {
    globalLogger = createLogger({
      level: (process.env.LOG_LEVEL as LogLevel) || "info",
      pretty: process.env.NODE_ENV !== "production",
    });
  }
  return globalLogger;
}

/** Set the global logger */
export function setLogger(logger: PinoLogger): void {
  globalLogger = logger;
}

/** Create a child logger */
export function getChildLogger(name: string): PinoLogger {
  return getLogger().child({ module: name });
}

export { type PinoLogger as Logger };
