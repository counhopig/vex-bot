/**
 * SqliteLoader tests — Tier 3 user-config reading from web_user_settings.
 *
 * Covers the fail-safe contract the runtime-config integration plan relies
 * on: missing DB, missing row, valid row, and corrupt row must all behave
 * deterministically (never throw; {} means "fall back to YAML").
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";
import { SqliteLoader } from "../src/config/resolvers/SqliteLoader.js";

const tempDirs: string[] = [];

function tmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "vex-sqlite-loader-"));
  tempDirs.push(dir);
  return join(dir, "web-auth.sqlite");
}

function createSettingsTable(dbPath: string, rows: Record<string, string>): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS web_user_settings (
      user_id TEXT PRIMARY KEY,
      settings_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  for (const [userId, json] of Object.entries(rows)) {
    db.prepare("INSERT INTO web_user_settings (user_id, settings_json, updated_at) VALUES (?, ?, ?)")
      .run(userId, json, Date.now());
  }
  db.close();
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("SqliteLoader", () => {
  it("returns {} when the database file does not exist", () => {
    const loader = new SqliteLoader({ dbPath: join(tmpdir(), "does-not-exist", "auth.sqlite") });
    expect(loader.load("u1")).toEqual({});
  });

  it("returns {} when the user has no settings row", () => {
    const dbPath = tmpDb();
    createSettingsTable(dbPath, {});
    const loader = new SqliteLoader({ dbPath });
    expect(loader.load("missing-user")).toEqual({});
  });

  it("returns the parsed settings for an existing row", () => {
    const dbPath = tmpDb();
    createSettingsTable(dbPath, {
      u1: JSON.stringify({ agent: { temperature: 0.2 }, persona: { persona_name: "PandaBot" } }),
    });
    const loader = new SqliteLoader({ dbPath });
    expect(loader.load("u1")).toEqual({
      agent: { temperature: 0.2 },
      persona: { persona_name: "PandaBot" },
    });
  });

  it("returns {} for a corrupt row instead of throwing (falls back to YAML)", () => {
    const dbPath = tmpDb();
    createSettingsTable(dbPath, { u1: "{not-valid-json" });
    const loader = new SqliteLoader({ dbPath });
    expect(loader.load("u1")).toEqual({});
  });

  it("returns {} when the table is missing entirely", () => {
    const dbPath = tmpDb();
    const db = new Database(dbPath);
    db.exec("CREATE TABLE unrelated (id INTEGER);");
    db.close();
    const loader = new SqliteLoader({ dbPath });
    expect(loader.load("u1")).toEqual({});
  });

  it("does not fail when the settings row is a non-object value", () => {
    const dbPath = tmpDb();
    createSettingsTable(dbPath, { u1: JSON.stringify("just-a-string") });
    const loader = new SqliteLoader({ dbPath });
    expect(loader.load("u1")).toEqual({});
  });

  it("reports whether any web users exist (hasAnyUsers)", () => {
    const dbPath = tmpDb();
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS web_users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    db.close();
    const loader = new SqliteLoader({ dbPath });
    expect(loader.hasAnyUsers()).toBe(false);

    writeFileSync(dbPath, ""); // corrupt the file; must not throw
    expect(loader.hasAnyUsers()).toBe(false);
    expect(loader.load("u1")).toEqual({});
  });
});
