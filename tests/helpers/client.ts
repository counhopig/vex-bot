import { vi } from "vitest";
import WebSocket from "ws";
import type { ClientMessage, ServerMessage } from "../../src/protocol/messages.js";

export class TestClient {
  readonly messages: ServerMessage[] = [];

  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (data) => this.messages.push(JSON.parse(data.toString()) as ServerMessage));
  }

  static connect(url: string, options: { cookie?: string; origin?: string; host?: string } = {}): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (options.cookie) headers.Cookie = options.cookie;
      if (options.host) headers.Host = options.host;
      const ws = new WebSocket(url, { headers, origin: options.origin });
      const client = new TestClient(ws);
      ws.once("open", () => resolve(client));
      ws.once("error", reject);
    });
  }

  send(message: ClientMessage): void {
    this.ws.send(JSON.stringify(message));
  }

  sendRaw(data: string): void {
    this.ws.send(data);
  }

  onceClose(listener: (code: number) => void): void {
    this.ws.once("close", (code) => listener(code));
  }

  waitFor(predicate: (m: ServerMessage) => boolean): Promise<ServerMessage> {
    return vi.waitFor(
      () => {
        const found = this.messages.find(predicate);
        if (!found) throw new Error("message not received yet");
        return found;
      },
      { timeout: 5000, interval: 10 },
    );
  }

  close(): void {
    this.ws.close();
  }
}
