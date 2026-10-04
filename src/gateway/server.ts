import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { Logger } from "pino";
import { WebSocket, WebSocketServer } from "ws";
import { ConfigError } from "../config/load.js";
import type { SettingsPatch, SettingsView } from "../config/settings.js";
import type { EventBus, VexEvent } from "../core/events.js";
import { webSessionKey, type SessionManager } from "../core/sessionManager.js";
import type { ApprovalManager } from "../policy/approvals.js";
import { parseClientMessage, type ClientMessage, type ServerMessage, type StatusInfo, type WorkspaceFile } from "../protocol/messages.js";
import { isLoopback, type WebAuth } from "./auth.js";

export interface GatewayOptions {
  host: string;
  port: number;
  auth: WebAuth;
  sessions: SessionManager;
  approvals: ApprovalManager;
  bus: EventBus;
  config: { read: () => Promise<string>; save: (text: string) => Promise<{ restarting?: boolean } | void> };
  status: () => StatusInfo | Promise<StatusInfo>;
  settings: { read: () => Promise<SettingsView & { catalog: { providers: string[]; models: Record<string, string[]> } }>; save: (patch: SettingsPatch) => Promise<{ restartRequired: boolean; restarting?: boolean }> };
  workspace: { read: (name: WorkspaceFile) => Promise<string>; save: (name: WorkspaceFile, text: string) => Promise<void> };
  staticDir: string;
  log: Logger;
}

interface StaticEntry {
  file: string;
  type: string;
  public: boolean;
}

const STATIC_FILES: Record<string, StaticEntry> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8", public: false },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8", public: false },
  "/login": { file: "login.html", type: "text/html; charset=utf-8", public: true },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8", public: true },
};

const WEB_PREFIX = "web:";

export class Gateway {
  private server: Server | undefined;
  private wss: WebSocketServer | undefined;
  private readonly clients = new Set<WebSocket>();
  private unsubscribe: (() => void) | undefined;
  private loginLockedUntil = 0;

  constructor(private readonly opts: GatewayOptions) {}

  async start(): Promise<{ port: number }> {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
    const server = createServer((req, res) => {
      this.handleHttp(req, res).catch((err: unknown) => {
        this.opts.log.error({ err }, "http request failed");
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    server.on("upgrade", (req, socket, head) => {
      socket.on("error", (err) => this.opts.log.warn({ err }, "websocket upgrade socket error"));
      try {
        let path: string;
        try {
          path = new URL(req.url ?? "/", "http://localhost").pathname;
        } catch {
          socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
        const localHostRequired = !this.opts.auth.required && !isLoopback(req.headers.host ?? "");
        if (localHostRequired || path !== "/ws" || !this.isSameOrigin(req) || !this.opts.auth.isAuthorized(req.headers.cookie)) {
          const status = localHostRequired ? "403 Forbidden" : "401 Unauthorized";
          socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
      } catch (err) {
        this.opts.log.warn({ err }, "websocket upgrade failed");
        socket.destroy();
      }
    });
    this.unsubscribe = this.opts.bus.on((event) => this.onBusEvent(event));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.opts.port, this.opts.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
    this.wss = wss;
    const address = server.address();
    return { port: typeof address === "object" && address ? address.port : this.opts.port };
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    for (const ws of this.clients) ws.terminate();
    this.wss?.close();
    const server = this.server;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    this.server = undefined;
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.opts.auth.required && !isLoopback(req.headers.host ?? "")) {
      res.writeHead(403).end();
      return;
    }
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method === "POST" && path === "/api/login") {
      await this.handleLogin(req, res);
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    const entry = STATIC_FILES[path];
    if (!entry) {
      res.writeHead(404).end();
      return;
    }
    if (!entry.public && !this.opts.auth.isAuthorized(req.headers.cookie)) {
      if (path === "/") res.writeHead(302, { Location: "/login" }).end();
      else res.writeHead(401).end();
      return;
    }
    const body = await readFile(join(this.opts.staticDir, entry.file));
    res.writeHead(200, { "Content-Type": entry.type, "Cache-Control": "no-cache" }).end(body);
  }

  private async handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (Date.now() < this.loginLockedUntil) {
      req.resume();
      res.writeHead(429, { "Retry-After": "1" }).end();
      return;
    }
    let token = "";
    try {
      const parsed: unknown = JSON.parse(await readBody(req, 4096));
      if (parsed && typeof parsed === "object" && typeof (parsed as { token?: unknown }).token === "string") {
        token = (parsed as { token: string }).token;
      }
    } catch {
      // A malformed body is treated as an empty token.
    }
    if (Date.now() < this.loginLockedUntil) {
      res.writeHead(429, { "Retry-After": "1" }).end();
      return;
    }
    if (!this.opts.auth.checkToken(token)) {
      this.loginLockedUntil = Date.now() + 1000;
      res.writeHead(401).end();
      return;
    }
    const headers = this.opts.auth.required ? { "Set-Cookie": this.opts.auth.setCookieHeader() } : undefined;
    res.writeHead(204, headers).end();
  }

  private isSameOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  private onConnection(ws: WebSocket): void {
    this.clients.add(ws);
    this.opts.log.info({ clients: this.clients.size }, "webchat connected");
    ws.on("error", (err) => this.opts.log.warn({ err }, "websocket error"));
    ws.on("close", () => {
      this.clients.delete(ws);
      this.opts.log.debug({ clients: this.clients.size }, "webchat disconnected");
    });
    ws.on("message", (data) => {
      void this.onClientMessage(ws, data.toString());
    });
    send(ws, { type: "sessions", sessions: this.opts.sessions.listWeb() });
    send(ws, { type: "approvals", pending: this.opts.approvals.pending() });
  }

  private async onClientMessage(ws: WebSocket, raw: string): Promise<void> {
    const message = parseClientMessage(raw);
    if (!message) {
      send(ws, { type: "error", message: "Unrecognized request" });
      return;
    }
    try {
      await this.handle(ws, message);
    } catch (err) {
      send(ws, { type: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  private async handle(ws: WebSocket, message: ClientMessage): Promise<void> {
    const { sessions } = this.opts;
    switch (message.type) {
      case "open": {
        const key = webSessionKey(message.sessionId);
        const session = await sessions.get(key);
        sessions.assertAvailable(key);
        const { items, streaming } = session.history();
        send(ws, { type: "history", sessionId: message.sessionId, items, busy: session.busy, streaming });
        return;
      }
      case "send": {
        const key = webSessionKey(message.sessionId);
        const session = await sessions.get(key);
        sessions.assertAvailable(key);
        session.send(message.text);
        return;
      }
      case "stop":
        (await sessions.get(webSessionKey(message.sessionId))).stop();
        return;
      case "create_session":
        send(ws, { type: "session_created", session: await sessions.createWeb() });
        return;
      case "rename_session":
        await sessions.renameWeb(message.sessionId, message.title);
        return;
      case "delete_session":
        await sessions.deleteWeb(message.sessionId);
        return;
      case "approve":
        this.opts.approvals.answer(message.id, message.answer);
        return;
      case "get_status":
        send(ws, { type: "status", status: await this.opts.status() });
        return;
      case "get_settings":
        send(ws, { type: "settings", ...(await this.opts.settings.read()) });
        return;
      case "save_settings":
        try {
          const { restartRequired, restarting } = await this.opts.settings.save({ set: message.set, unset: message.unset });
          send(ws, { type: "settings_saved", ok: true, restartRequired, restarting });
        } catch (err) {
          if (!(err instanceof ConfigError)) throw err;
          send(ws, { type: "settings_saved", ok: false, error: err.message });
        }
        return;
      case "get_file":
        send(ws, { type: "file", name: message.name, text: await this.opts.workspace.read(message.name) });
        return;
      case "save_file":
        try {
          await this.opts.workspace.save(message.name, message.text);
          send(ws, { type: "file_saved", name: message.name, ok: true });
        } catch (err) {
          this.opts.log.warn({ err, file: message.name }, "saving workspace file failed");
          send(ws, { type: "file_saved", name: message.name, ok: false, error: "Save failed; see the vexd log" });
        }
        return;
      case "get_config":
        send(ws, { type: "config", text: await this.opts.config.read() });
        return;
      case "save_config":
        try {
          const saved = await this.opts.config.save(message.text);
          send(ws, { type: "config_saved", ok: true, restarting: saved?.restarting });
        } catch (err) {
          if (!(err instanceof ConfigError)) throw err;
          send(ws, { type: "config_saved", ok: false, error: err.message });
        }
        return;
    }
  }

  private onBusEvent(event: VexEvent): void {
    if (event.type === "session") {
      if (!event.sessionKey.startsWith(WEB_PREFIX)) return;
      this.broadcast({ type: "event", sessionId: event.sessionKey.slice(WEB_PREFIX.length), event: event.event });
    } else if (event.type === "sessions_changed") {
      this.broadcast({ type: "sessions", sessions: this.opts.sessions.listWeb() });
    } else {
      this.broadcast({ type: "approvals", pending: this.opts.approvals.pending() });
    }
  }

  private broadcast(message: ServerMessage): void {
    for (const ws of this.clients) send(ws, message);
  }
}

function send(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
