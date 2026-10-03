import { createServer, type IncomingHttpHeaders, type Server } from "node:http";

export interface IlinkRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body: unknown;
}

export type IlinkResponder = (req: IlinkRequest) => unknown | Promise<unknown>;

export class FakeIlink {
  readonly requests: IlinkRequest[] = [];
  baseUrl = "";
  private readonly routes = new Map<string, IlinkResponder>();
  private readonly batches: unknown[][] = [];
  private server: Server | undefined;

  constructor() {
    this.routes.set("/ilink/bot/getupdates", () => ({ ret: 0, msgs: this.batches.shift() ?? [] }));
    this.routes.set("/ilink/bot/sendmessage", () => ({ ret: 0 }));
  }

  on(path: string, responder: IlinkResponder): void {
    this.routes.set(path, responder);
  }

  queueUpdates(...msgs: unknown[]): void {
    this.batches.push(msgs);
  }

  sentTexts(): string[] {
    return this.requests
      .filter((r) => r.path === "/ilink/bot/sendmessage")
      .map((r) => {
        const msg = (r.body as { msg: { item_list: { text_item: { text: string } }[] } }).msg;
        return msg.item_list[0]?.text_item.text ?? "";
      });
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const raw = Buffer.concat(chunks).toString("utf8");
        const request: IlinkRequest = {
          method: req.method ?? "GET",
          path: url.pathname,
          query: url.searchParams,
          headers: req.headers,
          body: raw ? (JSON.parse(raw) as unknown) : undefined,
        };
        this.requests.push(request);
        const responder = this.routes.get(url.pathname);
        if (!responder) {
          res.writeHead(404).end();
          return;
        }
        void Promise.resolve(responder(request)).then((result) => {
          if (typeof result === "number") {
            res.writeHead(result).end();
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
        });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (!address || typeof address !== "object") throw new Error("no address");
    this.baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export function textMessage(from: string, text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    from_user_id: from,
    context_token: `ctx-${from}`,
    item_list: [{ type: 1, text_item: { text } }],
    ...extra,
  };
}
