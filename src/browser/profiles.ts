/**
 * Chrome profile management
 *
 * Based on moltbot's profiles.ts and chrome.profile-decoration.ts implementation
 * Supports multi-profile management, port allocation, directory isolation
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import json5 from "json5";
import type { BrowserProfile, BrowserConfig } from "./types.js";
import { CDP_PORT_RANGE_START, CDP_PORT_RANGE_END, PROFILE_COLORS, DEFAULT_BROWSER_CONFIG } from "./types.js";

/** Profile name regex */
const PROFILE_NAME_REGEX = /^[a-z0-9][a-z0-9-]*$/;

/** Default browser data directory */
const BROWSER_DATA_DIR = join(homedir(), ".vex", "browser");

/** Profile data store path */
const PROFILES_STORE_PATH = join(BROWSER_DATA_DIR, "profiles.json");

/** Profile data store */
interface ProfilesStore {
  version: 1;
  profiles: Record<string, BrowserProfile>;
}

/**
 * Validate profile name format
 */
export function isValidProfileName(name: string): boolean {
  return PROFILE_NAME_REGEX.test(name) && name.length <= 32;
}

/**
 * Allocate a CDP port
 */
export function allocateCdpPort(usedPorts: Set<number>): number | null {
  for (let port = CDP_PORT_RANGE_START; port <= CDP_PORT_RANGE_END; port++) {
    if (!usedPorts.has(port)) {
      return port;
    }
  }
  return null;
}

/**
 * Allocate a profile color
 */
export function allocateColor(usedColors: Set<string>): string {
  for (const color of PROFILE_COLORS) {
    if (!usedColors.has(color)) {
      return color;
    }
  }
  return PROFILE_COLORS[0]!;
}

/**
 * Load profile data store
 */
export function loadProfilesStore(): ProfilesStore {
  if (!existsSync(PROFILES_STORE_PATH)) {
    return { version: 1, profiles: {} };
  }
  try {
    const content = readFileSync(PROFILES_STORE_PATH, "utf-8");
    return json5.parse(content) as ProfilesStore;
  } catch {
    return { version: 1, profiles: {} };
  }
}

/**
 * Save profile data store (atomic write)
 */
export function saveProfilesStore(store: ProfilesStore): void {
  mkdirSync(BROWSER_DATA_DIR, { recursive: true });

  const content = JSON.stringify(store, null, 2);
  const tmpPath = `${PROFILES_STORE_PATH}.${process.pid}.${Date.now()}.tmp`;

  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, PROFILES_STORE_PATH);
}

/**
 * Get the user data directory for a profile
 */
export function getProfileDataDir(profileName: string): string {
  return join(BROWSER_DATA_DIR, "profiles", profileName);
}

/**
 * Profile manager
 */
export class ProfileManager {
  private store: ProfilesStore;

  constructor() {
    this.store = loadProfilesStore();
  }

  /** Reload the store */
  reload(): void {
    this.store = loadProfilesStore();
  }

  /** List all profiles */
  list(): BrowserProfile[] {
    return Object.values(this.store.profiles);
  }

  /** Get a specific profile */
  get(name: string): BrowserProfile | undefined {
    return this.store.profiles[name];
  }

  /** Get the default profile */
  getDefault(): BrowserProfile {
    // Try finding an isDefault one first
    const defaultProfile = Object.values(this.store.profiles).find(p => p.isDefault);
    if (defaultProfile) return defaultProfile;

    // Try finding one named "default"
    if (this.store.profiles["default"]) {
      return this.store.profiles["default"];
    }

    // No profiles exist, create a default one
    return this.create({ name: "default", isDefault: true });
  }

  /** Create a profile */
  create(params: {
    name: string;
    color?: string;
    cdpPort?: number;
    isDefault?: boolean;
  }): BrowserProfile {
    const { name, color, isDefault } = params;

    if (!isValidProfileName(name)) {
      throw new Error(`Invalid profile name "${name}". Must match ${PROFILE_NAME_REGEX.toString()}`);
    }

    if (this.store.profiles[name]) {
      throw new Error(`Profile "${name}" already exists`);
    }

    // Allocate port
    const usedPorts = new Set(Object.values(this.store.profiles).map(p => p.cdpPort));
    const cdpPort = params.cdpPort ?? allocateCdpPort(usedPorts);
    if (!cdpPort) {
      throw new Error("No available CDP ports");
    }

    // Allocate color
    const usedColors = new Set(Object.values(this.store.profiles).map(p => p.color).filter(Boolean) as string[]);
    const profileColor = color ?? allocateColor(usedColors);

    // Create user data directory
    const userDataDir = getProfileDataDir(name);
    mkdirSync(userDataDir, { recursive: true });

    const profile: BrowserProfile = {
      name,
      cdpPort,
      userDataDir,
      color: profileColor,
      isDefault: isDefault ?? false,
      createdAt: Date.now(),
    };

    // If set as default, clear other default markers
    if (isDefault) {
      for (const p of Object.values(this.store.profiles)) {
        p.isDefault = false;
      }
    }

    this.store.profiles[name] = profile;
    saveProfilesStore(this.store);

    return profile;
  }

  /** Delete a profile */
  delete(name: string): boolean {
    const profile = this.store.profiles[name];
    if (!profile) return false;

    // Delete user data directory
    const dataDir = getProfileDataDir(name);
    if (existsSync(dataDir)) {
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        // Ignore deletion failure
      }
    }

    delete this.store.profiles[name];
    saveProfilesStore(this.store);

    return true;
  }

  /** Set a profile as default */
  setDefault(name: string): boolean {
    const profile = this.store.profiles[name];
    if (!profile) return false;

    for (const p of Object.values(this.store.profiles)) {
      p.isDefault = p.name === name;
    }

    saveProfilesStore(this.store);
    return true;
  }

  /** Reset profile data */
  reset(name: string): boolean {
    const profile = this.store.profiles[name];
    if (!profile) return false;

    const dataDir = getProfileDataDir(name);
    if (existsSync(dataDir)) {
      // Move to trash directory
      const trashDir = join(BROWSER_DATA_DIR, "trash");
      mkdirSync(trashDir, { recursive: true });
      const trashPath = join(trashDir, `${name}-${Date.now()}`);
      try {
        renameSync(dataDir, trashPath);
      } catch {
        rmSync(dataDir, { recursive: true, force: true });
      }
    }

    // Re-create an empty directory
    mkdirSync(dataDir, { recursive: true });
    return true;
  }
}
