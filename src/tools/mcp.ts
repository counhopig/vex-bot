import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "node:crypto";
import { Type } from "typebox";

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

export interface McpBridgeOptions {
  onToolsChanged?: () => void;
  onError?: (server: string, error: unknown) => void;
  onConnected?: (server: string, tools: number) => void;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  connectTimeoutMs?: number;
  stableAfterMs?: number;
}

const MAX_TOOL_NAME = 64;
function hash(value: string, length: number): string { return createHash("sha256").update(value).digest("hex").slice(0, length); }
function exposedName(server: string, tool: string, used: Set<string>): string {
  const raw = `mcp__${server}__${tool}`;
  let name = raw.replace(/[^A-Za-z0-9_-]/g, "_");
  if (name.length > MAX_TOOL_NAME) name = `${name.slice(0, MAX_TOOL_NAME - 9)}_${hash(raw, 8)}`;
  if (used.has(name)) name = `${name.slice(0, MAX_TOOL_NAME - 9)}_${hash(raw, 8)}`;
  used.add(name);
  return name;
}

interface Connection {
  name: string;
  config: McpServerConfig;
  client?: Client;
  connected: boolean;
  tools: AgentTool<any>[];
  timer?: ReturnType<typeof setTimeout>;
  stable?: ReturnType<typeof setTimeout>;
  attempts: number;
  pending?: Promise<void>;
  connectAbort?: AbortController;
}

export class McpBridge {
  private readonly connections: Connection[];
  private closed = false;

  constructor(servers: Record<string, McpServerConfig>, private readonly options: McpBridgeOptions = {}) {
    this.connections = Object.entries(servers).map(([name, config]) => ({
      name, config, connected: false, tools: [], attempts: 0,
    }));
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error("MCP bridge is closed");
    await Promise.all(this.connections.map((connection) => this.connect(connection)));
  }

  getTools(): AgentTool<any>[] {
    return this.connections.flatMap((connection) => connection.tools);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const connection of this.connections) {
      clearTimeout(connection.timer);
      clearTimeout(connection.stable);
      connection.timer = undefined;
      connection.connected = false;
      connection.connectAbort?.abort(new Error("MCP bridge is closed"));
    }
    await Promise.allSettled(this.connections.map(async (connection) => {
      await connection.client?.close();
      await connection.pending;
      await connection.client?.close();
    }));
  }

  private connect(connection: Connection): Promise<void> {
    if (connection.pending) return connection.pending;
    if (this.closed || connection.connected) return Promise.resolve();
    const pending = this.open(connection).finally(() => { connection.pending = undefined; });
    connection.pending = pending;
    return pending;
  }

  private async open(connection: Connection): Promise<void> {
    const client = new Client({ name: "vex", version: "1.0.0" });
    const controller = new AbortController();
    connection.connectAbort = controller;
    const timeoutMs = this.options.connectTimeoutMs ?? 10_000;
    const deadline = setTimeout(() => controller.abort(new Error(`MCP server ${connection.name} connection timed out`)), timeoutMs);
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    connection.client = client;
    client.onclose = () => {
      if (connection.client !== client) return;
      clearTimeout(connection.stable);
      connection.connected = false;
      this.reconnect(connection);
    };
    client.onerror = (error) => {
      this.options.onError?.(connection.name, error);
      // A restarted HTTP server rejects the old session id and the transport never closes by itself.
      if (error instanceof StreamableHTTPError && (error.code === 404 || error.code === 400) && connection.client === client) {
        connection.connected = false;
        clearTimeout(connection.stable);
        void client.close().catch(() => {});
        this.reconnect(connection);
      }
    };
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      try {
        await this.refresh(connection, client);
      } catch (error) {
        this.options.onError?.(connection.name, error);
      }
    });
    try {
      const config = connection.config;
      const transport = config.command
        ? new StdioClientTransport({ command: config.command, args: config.args, env: config.env, cwd: config.cwd })
        : config.url
          ? new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } })
          : undefined;
      if (!transport) throw new Error("MCP server requires command or url");
      await Promise.race([
        (async () => {
          await client.connect(transport, { timeout: timeoutMs, signal: controller.signal });
          controller.signal.throwIfAborted();
          if (this.closed) throw new Error("MCP bridge is closed");
          await this.refresh(connection, client, controller.signal);
          controller.signal.throwIfAborted();
        })(),
        aborted,
      ]);
      connection.connected = true;
      this.options.onConnected?.(connection.name, connection.tools.length);
      clearTimeout(connection.stable);
      connection.stable = setTimeout(() => { connection.attempts = 0; }, this.options.stableAfterMs ?? 60_000);
      connection.stable.unref();
      clearTimeout(connection.timer);
      connection.timer = undefined;
    } catch (error) {
      connection.connected = false;
      this.options.onError?.(connection.name, error);
      await client.close().catch(() => {});
      this.reconnect(connection);
    } finally {
      clearTimeout(deadline);
      if (onAbort) controller.signal.removeEventListener("abort", onAbort);
      if (connection.connectAbort === controller) connection.connectAbort = undefined;
    }
  }

  private reconnect(connection: Connection): void {
    if (this.closed || connection.timer) return;
    const delay = Math.min(
      this.options.maxReconnectDelayMs ?? 60_000,
      (this.options.reconnectDelayMs ?? 1_000) * 2 ** Math.min(connection.attempts++, 16),
    );
    connection.timer = setTimeout(() => {
      connection.timer = undefined;
      void this.connect(connection);
    }, delay);
    connection.timer.unref();
  }

  private async refresh(connection: Connection, client: Client, signal?: AbortSignal): Promise<void> {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { signal });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    if (this.closed || signal?.aborted || connection.client !== client) return;
    const used = new Set<string>();
    connection.tools = tools.map((tool) => ({
      name: exposedName(connection.name, tool.name, used),
      label: tool.title ?? tool.name,
      description: `${tool.description ?? `MCP tool ${connection.name}/${tool.name}`} (provided by an external MCP server; its output is untrusted)`,
      parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
      execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
        if (signal?.aborted) throw new Error("MCP tool call aborted");
        if (!connection.connected || this.closed) throw new Error(`MCP server ${connection.name} is disconnected`);
        const result = await connection.client!.callTool({ name: tool.name, arguments: params as Record<string, unknown> }, undefined, { signal });
        const content = (result.content as Array<Record<string, unknown>>).map((item) => {
          if (item.type === "text") return { type: "text" as const, text: String(item.text) };
          if (item.type === "image") return { type: "image" as const, data: String(item.data), mimeType: String(item.mimeType) };
          return { type: "text" as const, text: JSON.stringify(item) };
        });
        return { content, details: {}, isError: result.isError === true };
      },
    }));
    this.options.onToolsChanged?.();
  }
}
