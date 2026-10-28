import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createBashTool } from "./bash.js";
import { createEditTool, createReadTool, createWriteTool } from "./fs.js";
import type { Sandbox } from "./sandbox.js";
import { createFindTool, createGrepTool } from "./search.js";

export interface CoreToolOptions {
  workspace: string;
  bashEnvPassthrough: string[];
  configPath?: string;
  sandbox?: Sandbox;
}

export function createCoreTools(opts: CoreToolOptions): AgentTool<any>[] {
  return [
    createReadTool(opts.workspace),
    createWriteTool(opts.workspace),
    createEditTool(opts.workspace),
    createBashTool({ workspace: opts.workspace, envPassthrough: opts.bashEnvPassthrough, configPath: opts.configPath, ...(opts.sandbox ? { sandbox: opts.sandbox } : {}) }),
    createGrepTool(opts.workspace),
    createFindTool(opts.workspace),
  ];
}
