import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface VexPaths {
  home: string;
  config: string;
  sessions: string;
  webSessions: string;
  logs: string;
  logFile: string;
  pidFile: string;
  defaultWorkspace: string;
  wechat: string;
}

export function resolvePaths(home?: string): VexPaths {
  const root = resolve(home ?? process.env.VEX_HOME ?? join(homedir(), ".vex"));
  return {
    home: root,
    config: join(root, "config.yaml"),
    sessions: join(root, "sessions"),
    webSessions: join(root, "sessions", "web"),
    logs: join(root, "logs"),
    logFile: join(root, "logs", "vexd.log"),
    pidFile: join(root, "vexd.pid"),
    defaultWorkspace: join(root, "workspace"),
    wechat: join(root, "wechat"),
  };
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}
