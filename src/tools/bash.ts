import { spawn } from "node:child_process";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

const BASE_ENV_ALLOWLIST = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "TMPDIR", "TZ",
  "http_proxy", "https_proxy", "ftp_proxy", "all_proxy", "no_proxy",
  "HTTP_PROXY", "HTTPS_PROXY", "FTP_PROXY", "ALL_PROXY", "NO_PROXY",
];

const MAX_RESULT_CHARS = 30_000;
const HALF = MAX_RESULT_CHARS / 2;

export function buildChildEnv(passthrough: string[], source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allow = new Set([...BASE_ENV_ALLOWLIST, ...passthrough]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && (allow.has(key) || key.startsWith("LC_"))) env[key] = value;
  }
  return env;
}

export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n…（省略 ${text.length - half * 2} 个字符）…\n${text.slice(text.length - half)}`;
}

const BashParams = Type.Object({
  command: Type.String({ description: "要执行的 shell 命令" }),
  timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 600, description: "超时秒数，默认 120，最长 600" })),
});

interface BashOptions {
  workspace: string;
  envPassthrough: string[];
  configPath?: string;
}

export function createBashTool(opts: BashOptions): AgentTool<typeof BashParams> {
  return {
    name: "bash",
    label: "执行命令",
    description: "在 bash 中执行命令，返回合并后的标准输出与标准错误。默认工作目录是工作区。",
    parameters: BashParams,
    execute: (_id, { command, timeout = 120 }, signal) => runCommand(command, opts, timeout, signal),
  };
}

function runCommand(
  command: string,
  opts: BashOptions,
  timeoutSec: number,
  signal: AbortSignal | undefined,
): Promise<AgentToolResult<{ exitCode: number }>> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("命令已中断"));
      return;
    }
    const child = spawn("bash", ["-c", command], {
      cwd: opts.workspace,
      env: { ...buildChildEnv(opts.envPassthrough), ...(opts.configPath ? { VEX_CONFIG_PATH: opts.configPath } : {}) },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Keep only the head and a rolling tail so huge outputs never sit in memory.
    let head = "";
    let tail = "";
    let total = 0;
    const collect = (chunk: string) => {
      total += chunk.length;
      let rest = chunk;
      if (head.length < HALF) {
        const take = rest.slice(0, HALF - head.length);
        head += take;
        rest = rest.slice(take.length);
      }
      if (rest) tail = (tail + rest).slice(-HALF);
    };
    child.stdout.setEncoding("utf8").on("data", collect);
    child.stderr.setEncoding("utf8").on("data", collect);
    const output = () =>
      total <= MAX_RESULT_CHARS ? head + tail : `${head}\n…（省略 ${total - head.length - tail.length} 个字符）…\n${tail}`;

    let stopReason: "timeout" | "aborted" | undefined;
    const killGroup = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group already exited.
      }
    };
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      child.stdout.removeListener("data", collect);
      child.stderr.removeListener("data", collect);
      child.removeListener("close", onClose);
      child.removeListener("error", onError);
    };
    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onClose = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      const text = output();
      if (stopReason === "timeout") {
        reject(new Error(`命令超时（${timeoutSec} 秒）已终止\n${text}`));
      } else if (stopReason === "aborted") {
        reject(new Error("命令已中断"));
      } else if (code !== 0) {
        reject(new Error(`${text}\n[退出码 ${code ?? "未知"}]`));
      } else {
        resolve({ content: [{ type: "text", text: text || "(无输出)" }], details: { exitCode: 0 } });
      }
    };
    const stop = (reason: "timeout" | "aborted") => {
      if (settled) return;
      stopReason = reason;
      killGroup();
      // Escaped descendants may still hold these pipes after the group exits.
      child.stdout.destroy();
      child.stderr.destroy();
      if (child.pid === undefined) child.once("error", () => {});
      onClose(null);
    };
    const timer = setTimeout(() => stop("timeout"), timeoutSec * 1000);
    const onAbort = () => stop("aborted");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", onError);
    child.on("close", onClose);
    if (signal?.aborted) onAbort();
  });
}
