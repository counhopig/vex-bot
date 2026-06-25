/**
 * Browser module type definitions
 */

/** Browser profile */
export interface BrowserProfile {
  /** Profile name */
  name: string;
  /** CDP debug port */
  cdpPort: number;
  /** User data directory path */
  userDataDir: string;
  /** Theme color (hexadecimal) */
  color?: string;
  /** Whether it is the default profile */
  isDefault?: boolean;
  /** Creation time */
  createdAt?: number;
}

/** Browser configuration */
export interface BrowserConfig {
  /** Whether browser control is enabled */
  enabled: boolean;
  /** Whether to run in headless mode */
  headless: boolean;
  /** Default profile name */
  defaultProfile: string;
  /** Profile list */
  profiles: Record<string, Partial<BrowserProfile>>;
  /** Chrome executable path (optional) */
  executablePath?: string;
  /** Default viewport width */
  viewportWidth: number;
  /** Default viewport height */
  viewportHeight: number;
  /** Default timeout (milliseconds) */
  defaultTimeout: number;
  /** Screenshot maximum side length */
  screenshotMaxSide: number;
  /** Screenshot maximum bytes */
  screenshotMaxBytes: number;
  /** Snapshot maximum characters */
  snapshotMaxChars: number;
}

/** Default browser configuration */
export const DEFAULT_BROWSER_CONFIG: BrowserConfig = {
  enabled: true,
  headless: true,
  defaultProfile: "default",
  profiles: {},
  viewportWidth: 1280,
  viewportHeight: 720,
  defaultTimeout: 30000,
  screenshotMaxSide: 2000,
  screenshotMaxBytes: 5 * 1024 * 1024, // 5MB
  snapshotMaxChars: 80000,
};

/** CDP port range */
export const CDP_PORT_RANGE_START = 19800;
export const CDP_PORT_RANGE_END = 19899;

/** Profile color presets */
export const PROFILE_COLORS = [
  "#FF4500", // Orange-red
  "#0066CC", // Blue
  "#00AA00", // Green
  "#9932CC", // Purple
  "#FF1493", // Pink
  "#FFD700", // Gold
  "#00CED1", // Cyan
  "#8B4513", // Brown
  "#708090", // Slate
  "#2F4F4F", // Dark slate
];

/** Browser tab information */
export interface BrowserTab {
  /** Target ID */
  targetId: string;
  /** Page title */
  title: string;
  /** Page URL */
  url: string;
  /** WebSocket debug URL */
  wsUrl?: string;
  /** Target type */
  type?: string;
}

/** Element reference information */
export interface ElementRef {
  /** Role */
  role: string;
  /** Name */
  name?: string;
  /** Nth element with the same role+name (0-based) */
  nth?: number;
}

/** Element reference mapping */
export type RefMap = Map<string, ElementRef>;

/** Browser session state */
export interface BrowserSessionState {
  /** Profile name */
  profileName: string;
  /** Playwright Browser instance */
  browser: unknown;
  /** Playwright BrowserContext instance */
  context: unknown;
  /** Current active page */
  page: unknown;
  /** Element reference mapping */
  refs: RefMap;
  /** Reference mode */
  refsMode: "aria" | "role";
  /** Whether to run in headless mode */
  headless: boolean;
  /** Start time */
  startedAt: number;
  /** Console logs */
  consoleLogs: ConsoleLogEntry[];
  /** Page errors */
  pageErrors: PageError[];
  /** Network request records */
  networkRequests: NetworkRequest[];
}

/** Console log entry */
export interface ConsoleLogEntry {
  type: "log" | "info" | "warn" | "error" | "debug";
  text: string;
  timestamp: number;
}

/** Page error */
export interface PageError {
  message: string;
  stack?: string;
  timestamp: number;
}

/** Network request record */
export interface NetworkRequest {
  url: string;
  method: string;
  status?: number;
  timestamp: number;
}

/** Screenshot options */
export interface ScreenshotOptions {
  /** Whether to take a full-page screenshot */
  fullPage?: boolean;
  /** Element reference */
  ref?: string;
  /** CSS selector */
  selector?: string;
  /** Image format */
  format?: "png" | "jpeg";
  /** JPEG quality (0-100) */
  quality?: number;
  /** Whether to draw element labels */
  withLabels?: boolean;
  /** Maximum number of labels */
  maxLabels?: number;
}

/** Screenshot result */
export interface ScreenshotResult {
  /** Image buffer */
  buffer: Buffer;
  /** Content type */
  contentType: "image/png" | "image/jpeg";
  /** Original size */
  originalSize?: { width: number; height: number };
  /** Whether it was compressed */
  compressed?: boolean;
  /** Number of labels drawn */
  labelsDrawn?: number;
}

/** Snapshot options */
export interface SnapshotOptions {
  /** Maximum characters */
  maxChars?: number;
  /** Selector (default body) */
  selector?: string;
  /** Whether to include static content */
  includeStatic?: boolean;
}

/** Snapshot result */
export interface SnapshotResult {
  /** Page URL */
  url: string;
  /** Page title */
  title: string;
  /** ARIA snapshot text */
  ariaSnapshot?: string;
  /** Element reference mapping */
  refs: RefMap;
  /** Number of elements */
  elementsCount: number;
  /** Whether it was truncated */
  truncated?: boolean;
}

/** Browser action request */
export type BrowserAction =
  | { kind: "click"; ref: string; doubleClick?: boolean; button?: "left" | "right" | "middle"; modifiers?: string[] }
  | { kind: "type"; ref: string; text: string; slowly?: boolean; submit?: boolean }
  | { kind: "press"; key: string; modifiers?: string[] }
  | { kind: "hover"; ref: string }
  | { kind: "scroll"; ref?: string; direction?: "up" | "down" | "left" | "right"; amount?: number }
  | { kind: "drag"; startRef: string; endRef: string }
  | { kind: "select"; ref: string; values: string[] }
  | { kind: "fill"; fields: Array<{ ref: string; type: string; value: string | boolean | number }> }
  | { kind: "wait"; condition: "selector" | "text" | "textGone" | "timeout" | "load" | "network" | "url"; value?: string; amount?: number }
  | { kind: "evaluate"; code: string; ref?: string }
  | { kind: "close" };

/** Browser action result */
export interface BrowserActionResult {
  success: boolean;
  action: string;
  details?: Record<string, unknown>;
  error?: string;
}
