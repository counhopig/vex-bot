import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpBridge } from "../src/tools/mcp.js";

const server = `
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const server = new Server({ name: 'test', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
 { name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
 { name: 'fail', inputSchema: { type: 'object', properties: {} } },
 { name: 'wait', inputSchema: { type: 'object', properties: {} } },
 { name: 'exit', inputSchema: { type: 'object', properties: {} } },
] }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
 if (params.name === 'exit') { setTimeout(() => process.exit(0), 10); return { content: [{ type: 'text', text: 'bye' }] }; }
 if (params.name === 'wait') await new Promise((resolve, reject) => {
   const timer = setTimeout(resolve, 30000);
   extra.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); });
 });
 return { content: [{ type: 'text', text: params.arguments?.text ?? 'failure' }], isError: params.name === 'fail' };
});
await server.connect(new StdioServerTransport());
`;

const oddNames = server
  .replace("{ name: 'echo',", "{ name: 'a.b', description: 'Dotted', inputSchema: { type: 'object', properties: {} } },\n { name: 'a_b', inputSchema: { type: 'object', properties: {} } },\n { name: 'x'.repeat(100), inputSchema: { type: 'object', properties: {} } },\n { name: 'echo',");

describe("MCP bridge", () => {
  const bridges: McpBridge[] = [];
  afterEach(async () => { await Promise.all(bridges.splice(0).map((bridge) => bridge.close())); });
  function create(options: ConstructorParameters<typeof McpBridge>[1] = {}) {
    const bridge = new McpBridge({ local: { command: process.execPath, args: ["--input-type=module", "-e", server] } }, options);
    bridges.push(bridge);
    return bridge;
  }

  it("discovers stdio tools and preserves server failures", async () => {
    let changes = 0;
    const bridge = create({ onToolsChanged: () => { changes++; } });
    await bridge.start();
    expect(changes).toBe(1);
    const echo = bridge.getTools().find((tool) => tool.name === "mcp__local__echo")!;
    expect(echo.parameters.required).toEqual(["text"]);
    expect(await echo.execute("1", { text: "你好" })).toMatchObject({ content: [{ type: "text", text: "你好" }], isError: false });
    expect(await bridge.getTools().find((tool) => tool.name.endsWith("__fail"))!.execute("2", {})).toMatchObject({ isError: true });
  });

  it("does not fail startup when a server cannot connect", async () => {
    const errors: unknown[] = [];
    const bridge = new McpBridge({ missing: { command: "/nonexistent-vex-mcp-test" } }, { onError: (_name, error) => errors.push(error) });
    bridges.push(bridge);
    await expect(bridge.start()).resolves.toBeUndefined();
    expect(bridge.getTools()).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("cancels an active request and rejects calls after close", async () => {
    const bridge = create();
    await bridge.start();
    const tool = bridge.getTools().find((tool) => tool.name.endsWith("__wait"))!;
    const controller = new AbortController();
    const pending = tool.execute("1", {}, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
    await bridge.close();
    await expect(tool.execute("2", {})).rejects.toThrow("disconnected");
  });

  it("exposes tool names that satisfy provider limits, with originals kept for calls", async () => {
    const bridge = new McpBridge({ local: { command: process.execPath, args: ["--input-type=module", "-e", oddNames] } });
    bridges.push(bridge);
    await bridge.start();
    const names = bridge.getTools().map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(names).toContain("mcp__local__a_b");
    expect(names.filter((name) => name.startsWith("mcp__local__a_b"))).toHaveLength(2);
    const dotted = bridge.getTools().find((tool) => tool.description.startsWith("Dotted"))!;
    expect(dotted.description).toContain("untrusted");
    expect(await bridge.getTools().find((tool) => tool.name.startsWith("mcp__local__echo"))!.execute("1", { text: "hi" })).toEqual(expect.objectContaining({ details: {}, isError: false }));
  });

  it("keeps the connection when the client reports a non-fatal error", async () => {
    const errors: unknown[] = [];
    const bridge = create({ onError: (_server, error) => errors.push(error) });
    await bridge.start();
    const connection = (bridge as any).connections[0];
    connection.client.onerror(new Error("stream hiccup"));
    expect(errors).toHaveLength(1);
    expect(connection.connected).toBe(true);
    const echo = bridge.getTools().find((tool) => tool.name.endsWith("__echo"))!;
    expect(await echo.execute("1", { text: "still" })).toMatchObject({ content: [{ type: "text", text: "still" }] });
  });

  it("reconnects when an HTTP server rejects the session", async () => {
    const bridge = create({ reconnectDelayMs: 100 });
    await bridge.start();
    const connection = (bridge as any).connections[0];
    const first = connection.client;
    first.onerror(new StreamableHTTPError(404, "session not found"));
    expect(connection.connected).toBe(false);
    await expect.poll(() => connection.connected).toBe(true);
    expect(connection.client).not.toBe(first);
  });

  it("keeps growing the reconnect delay until a connection has stayed up", async () => {
    const bridge = create({ reconnectDelayMs: 100 });
    await bridge.start();
    await bridge.getTools().find((tool) => tool.name.endsWith("__exit"))!.execute("1", {});
    await new Promise((resolve) => setTimeout(resolve, 60));
    await expect.poll(() => (bridge as any).connections[0].connected).toBe(true);
    expect((bridge as any).connections[0].attempts).toBe(1);
  });

  it("retains known tools while disconnected and reconnects", async () => {
    const bridge = create({ reconnectDelayMs: 200 });
    await bridge.start();
    const echo = bridge.getTools().find((tool) => tool.name.endsWith("__echo"))!;
    await bridge.getTools().find((tool) => tool.name.endsWith("__exit"))!.execute("1", {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(echo.execute("2", { text: "test" })).rejects.toThrow("disconnected");
    await expect.poll(async () => {
      try { return (await echo.execute("3", { text: "back" })).content[0]; } catch { return undefined; }
    }).toEqual({ type: "text", text: "back" });
  });

  it("connects through Streamable HTTP with configured headers", async () => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true });
    const sdk = new Server({ name: "http-test", version: "1" }, { capabilities: { tools: {} } });
    sdk.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "hello", inputSchema: { type: "object" as const } }] }));
    sdk.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text" as const, text: "HTTP connected" }] }));
    await sdk.connect(transport);
    const http = createServer((request, response) => {
      if (request.headers.authorization !== "Bearer test") { response.writeHead(401).end(); return; }
      void transport.handleRequest(request, response).catch(() => response.destroy());
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("No HTTP address");
    const bridge = new McpBridge({ remote: { url: `http://127.0.0.1:${address.port}/mcp`, headers: { Authorization: "Bearer test" } } });
    bridges.push(bridge);
    try {
      await bridge.start();
      const tool = bridge.getTools()[0]!;
      expect(tool.name).toBe("mcp__remote__hello");
      expect(await tool.execute("1", {})).toMatchObject({ content: [{ type: "text", text: "HTTP connected" }] });
    } finally {
      await bridge.close();
      await sdk.close();
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("bounds the complete HTTP handshake when initialized notification hangs", async () => {
    let hungNotifications = 0;
    let initializations = 0;
    const http = createServer((request, response) => {
      if (request.method !== "POST") { response.writeHead(405).end(); return; }
      let body = "";
      request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      request.on("end", () => {
        const message = JSON.parse(body) as { method: string; id?: number };
        if (message.method === "initialize") {
          initializations++;
          response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
            jsonrpc: "2.0", id: message.id, result: {
              protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "hung", version: "1" },
            },
          }));
        } else if (message.method === "notifications/initialized") {
          hungNotifications++;
          // Keep the connection open to reproduce the SDK notification path lacking a request timeout.
        } else response.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("No HTTP address");
    const errors: unknown[] = [];
    const bridge = new McpBridge({ hung: { url: `http://127.0.0.1:${address.port}/mcp` } }, {
      connectTimeoutMs: 100, reconnectDelayMs: 50, onError: (_name, error) => errors.push(error),
    });
    bridges.push(bridge);
    try {
      const started = Date.now();
      await bridge.start();
      expect(Date.now() - started).toBeLessThan(1000);
      expect(hungNotifications).toBe(1);
      expect(bridge.getTools()).toEqual([]);
      expect(errors.some((error) => String(error).includes("timed out"))).toBe(true);
      await expect.poll(() => initializations).toBeGreaterThanOrEqual(2);
      await bridge.close();
      const attempts = initializations;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(initializations).toBe(attempts);
    } finally {
      await bridge.close();
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
    }
  });
});
