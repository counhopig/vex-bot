import { isMap, parseDocument, type Document } from "yaml";
import type { VexPaths } from "../paths.js";
import { ConfigError, parseConfig } from "./load.js";

export type SettingValue = string | number | boolean | string[];
export interface SettingsPatch { set?: Record<string, SettingValue>; unset?: string[] }
export interface SettingsView { values: Record<string, SettingValue>; secrets: string[] }

const NAME = "[A-Za-z0-9_-]+";
const ALLOWED = [
  /^model\.(provider|id|thinking)$/,
  /^backgroundModel\.(provider|id|thinking)$/,
  new RegExp(`^providers\\.${NAME}\\.(apiKey|baseUrl|api)$`),
  /^wechat\.(enabled|ownerId)$/,
  /^stt\.(provider|baseUrl|model|apiKey|language|chunkMinutes|maxMinutes)$/,
  /^links\.bilibili\.sessdata$/,
  /^vault\.(path|url|branch|username|token)$/,
  /^wiki\.(enabled|every|notify|maxNotesPerRun)$/,
  /^webSearch\.(provider|apiKey|baseUrl)$/,
  /^heartbeat\.(every|activeHours)$/,
  /^memory\.consolidateAt$/,
  /^compaction\.threshold$/,
  /^persona\.sleep$/,
  /^persona\.outreach\.(enabled|checkEvery|dailyLimit|socialThreshold|quietHours)$/,
];
const SECRET = /\.(apiKey|sessdata|token)$/;
// Skills read these on every run, so a saved change applies without a restart.
const LIVE = /^(stt|links)\./;

export const isEditable = (path: string): boolean => ALLOWED.some((pattern) => pattern.test(path));

function walk(value: unknown, prefix: string, out: Record<string, unknown>): void {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) walk(child, prefix ? `${prefix}.${key}` : key, out);
  } else if (prefix) {
    out[prefix] = value;
  }
}

export function readSettings(text: string): SettingsView {
  const flat: Record<string, unknown> = {};
  walk(parseDocument(text).toJS(), "", flat);
  const values: Record<string, SettingValue> = {};
  const secrets: string[] = [];
  for (const [path, value] of Object.entries(flat)) {
    if (!isEditable(path)) continue;
    if (SECRET.test(path)) { if (typeof value === "string" && value) secrets.push(path); continue; }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") values[path] = value;
    else if (Array.isArray(value) && value.every((item) => typeof item === "string")) values[path] = value as string[];
  }
  return { values, secrets };
}

function validValue(value: unknown): value is SettingValue {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" || (Array.isArray(value) && value.every((item) => typeof item === "string"));
}

function pruneEmptyMaps(doc: Document): void {
  const prune = (node: unknown): boolean => {
    if (!isMap(node)) return false;
    node.items = node.items.filter((pair) => !prune(pair.value));
    return node.items.length === 0;
  };
  if (isMap(doc.contents)) prune(doc.contents);
}

/** Applies a patch to the YAML text, keeping comments and keys the form does not know about. */
export function applySettings(text: string, patch: SettingsPatch, paths: VexPaths): { text: string; restartRequired: boolean } {
  const doc = parseDocument(text);
  if (doc.errors.length) throw new ConfigError("config.yaml is not valid YAML; fix it in Advanced first");
  const touched = [...Object.keys(patch.set ?? {}), ...(patch.unset ?? [])];
  for (const path of touched) if (!isEditable(path)) throw new ConfigError(`${path} cannot be changed through the forms`);
  for (const [path, value] of Object.entries(patch.set ?? {})) {
    if (!validValue(value)) throw new ConfigError(`Invalid value for ${path}`);
    doc.setIn(path.split("."), value);
  }
  for (const path of patch.unset ?? []) doc.deleteIn(path.split("."));
  pruneEmptyMaps(doc);
  const next = String(doc);
  parseConfig(next, paths);
  return { text: next, restartRequired: touched.some((path) => !LIVE.test(path)) };
}
