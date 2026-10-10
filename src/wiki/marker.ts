import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../store/atomic.js";

export type FileFingerprint = { type: "absent"; hash: null } | { type: "file"; hash: string };

export interface TouchedPath {
  path: string;
  expectedBefore: FileFingerprint;
  after?: FileFingerprint;
}

export interface InFlightMarker {
  batchId: string;
  kind: "scheduled" | "bootstrap" | "on-demand";
  advancesScan: boolean;
  scanBase: string | null;
  baseHead: string;
  phase: "writing" | "committed";
  commit: string | null;
  touched: TouchedPath[];
}

const MARKER_FILE = "vex-wiki-inflight.json";

function isFingerprint(value: unknown): value is FileFingerprint {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { type?: unknown; hash?: unknown };
  if (candidate.type === "absent") return candidate.hash === null;
  if (candidate.type === "file") return typeof candidate.hash === "string";
  return false;
}

function sameFingerprint(a: FileFingerprint, b: FileFingerprint): boolean {
  return a.type === b.type && a.hash === b.hash;
}

function parseMarker(text: string): InFlightMarker | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const marker = parsed as InFlightMarker;
  if (typeof marker.batchId !== "string") return null;
  if (marker.phase !== "writing" && marker.phase !== "committed") return null;
  if (!Array.isArray(marker.touched) || !marker.touched.every((entry) => typeof entry?.path === "string" && isFingerprint(entry.expectedBefore))) return null;
  return marker;
}

/**
 * The crash-safety record for one wiki batch, stored inside the repository's `.git`
 * directory so it is never part of a commit. The wiki lock serializes access, so this
 * store does no locking of its own.
 */
export class MarkerStore {
  private readonly file: string;

  constructor(gitDir: string) {
    this.file = join(gitDir, MARKER_FILE);
  }

  async read(): Promise<InFlightMarker | null> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    return parseMarker(text);
  }

  async begin(marker: InFlightMarker): Promise<void> {
    await this.write(marker);
  }

  async setCommitted(commit: string): Promise<void> {
    const marker = await this.load();
    await this.write({ ...marker, phase: "committed", commit });
  }

  async remove(): Promise<void> {
    await rm(this.file, { force: true });
  }

  async recordIntent(path: string, expectedBefore: FileFingerprint): Promise<void> {
    const marker = await this.load();
    const touched = marker.touched.filter((entry) => entry.path !== path);
    touched.push({ path, expectedBefore });
    await this.write({ ...marker, touched });
  }

  async recordAfter(path: string, after: FileFingerprint): Promise<void> {
    const marker = await this.load();
    if (!marker.touched.some((entry) => entry.path === path)) throw new Error(`no recorded intent for ${path}`);
    const touched = marker.touched.map((entry) => (entry.path === path ? { ...entry, after } : entry));
    await this.write({ ...marker, touched });
  }

  private async load(): Promise<InFlightMarker> {
    const marker = await this.read();
    if (!marker) throw new Error("no in-flight wiki marker");
    return marker;
  }

  private async write(marker: InFlightMarker): Promise<void> {
    await writeFileAtomic(this.file, `${JSON.stringify(marker, null, 2)}\n`);
  }
}

export async function fingerprint(absPath: string): Promise<FileFingerprint> {
  let bytes: Buffer;
  try {
    bytes = await readFile(absPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { type: "absent", hash: null };
    throw error;
  }
  return { type: "file", hash: createHash("sha256").update(bytes).digest("hex") };
}

export async function assertUnchanged(absPath: string, expected: FileFingerprint): Promise<void> {
  const current = await fingerprint(absPath);
  if (!sameFingerprint(current, expected)) {
    throw new Error(`wiki path changed since it was recorded: ${absPath}`);
  }
}

export function expectedBeforeFor(marker: InFlightMarker, path: string, baseline: FileFingerprint): FileFingerprint {
  const entry = marker.touched.find((candidate) => candidate.path === path);
  return entry?.after ?? baseline;
}
