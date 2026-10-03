import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../../store/atomic.js";

export interface WeChatCredentials {
  token: string;
  accountId: string;
  baseUrl: string;
  userId?: string;
}

export interface WeChatState {
  contextToken?: string;
}

export class WeChatStore {
  readonly credentialsFile: string;
  readonly stateFile: string;

  constructor(dir: string) {
    this.credentialsFile = join(dir, "credentials.json");
    this.stateFile = join(dir, "state.json");
  }

  async loadCredentials(): Promise<WeChatCredentials | undefined> {
    const value = await readJson(this.credentialsFile);
    if (!value || typeof value !== "object") return undefined;
    const c = value as Record<string, unknown>;
    if (typeof c.token !== "string" || !c.token || typeof c.baseUrl !== "string" || !c.baseUrl) return undefined;
    return {
      token: c.token,
      accountId: typeof c.accountId === "string" ? c.accountId : "",
      baseUrl: c.baseUrl,
      userId: typeof c.userId === "string" && c.userId ? c.userId : undefined,
    };
  }

  async saveCredentials(credentials: WeChatCredentials): Promise<void> {
    await writeFileAtomic(this.credentialsFile, `${JSON.stringify(credentials, null, 2)}\n`, 0o600, 0o700);
  }

  async loadState(): Promise<WeChatState> {
    const value = await readJson(this.stateFile);
    if (!value || typeof value !== "object") return {};
    const contextToken = (value as Record<string, unknown>).contextToken;
    return typeof contextToken === "string" && contextToken ? { contextToken } : {};
  }

  async saveState(state: WeChatState): Promise<void> {
    await writeFileAtomic(this.stateFile, `${JSON.stringify(state)}\n`, 0o600, 0o700);
  }
}

async function readJson(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
