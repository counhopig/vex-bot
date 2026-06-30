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
    pretty = false,
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
      level: "info",
      pretty: false,
    });
  }
  return globalLogger;
}

/** Set the global logger */
export function setLogger(logger: PinoLogger): void {
  globalLogger = logger;
}

export function getChildLogger(name: string): PinoLogger {
  let child: PinoLogger | null = null;
  let parent: PinoLogger | null = null;

  return new Proxy({} as PinoLogger, {
    get(_target, prop) {
      const currentParent = getLogger();
      if (parent !== currentParent) {
        parent = currentParent;
        child = currentParent.child({ module: name });
      }
      const value = (child as unknown as Record<string | symbol, unknown>)[prop];
      if (typeof value === "function") {
        return value.bind(child);
      }
      return value;
    },
  });
}

export { type PinoLogger as Logger };
