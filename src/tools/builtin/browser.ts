/**
 * Built-in tool - Browser control
 *
 * Playwright-based browser automation tool
 * Supports page navigation, screenshots, content extraction, element interactions, etc.
 */

import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { jsonResult, errorResult, readStringParam, readNumberParam, readBooleanParam } from "../common.js";
import { assertWebFetchUrlAllowed, allowPrivateNetwork } from "./web.js";
import { GLOBAL_OWNER_KEY } from "./process-registry.js";
import type { Browser, BrowserContext, Page } from "playwright-core";

// Browser session state
interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  refs: Map<string, { role: string; name?: string; nth?: number }>;
  refsMode: "aria" | "role";
}

// One browser session per owner (per-user sandbox). A shared module singleton
// would let any user drive — and read cookies/logged-in state from — another
// user's browser. Keyed by ownerKey so sessions stay isolated.
const browserSessions = new Map<string, BrowserSession>();
type PlaywrightModule = typeof import("playwright-core");
let playwrightModule: PlaywrightModule | null = null;

/** Lazy-load Playwright */
async function getPlaywright(): Promise<PlaywrightModule> {
  if (!playwrightModule) {
    try {
      playwrightModule = await import("playwright-core");
    } catch {
      throw new Error("Playwright not installed. Run: npm install playwright-core");
    }
  }
  return playwrightModule;
}

/** Get the owner's browser session, or throw if it hasn't been started. */
function getBrowserSession(ownerKey: string): BrowserSession {
  const session = browserSessions.get(ownerKey);
  if (!session) throw new Error("Browser not started. Use 'start' action first.");
  return session;
}

/** Close and forget an owner's browser session (idempotent). */
export async function disposeBrowserOwner(ownerKey: string): Promise<void> {
  const session = browserSessions.get(ownerKey);
  if (!session) return;
  browserSessions.delete(ownerKey);
  try { await session.browser.close(); } catch {
    // Browser may already be torn down; ignore.
  }
}

/** Close every browser session (used on shutdown to avoid leaking chromium). */
export async function disposeAllBrowsers(): Promise<void> {
  await Promise.all(Array.from(browserSessions.keys()).map((k) => disposeBrowserOwner(k)));
}

/** Chromium launch args. The sandbox is disabled only on explicit opt-in
 *  (VEX_BROWSER_NO_SANDBOX=1) — needed inside some containers, but a real
 *  security downgrade, so it must never be the default. */
export function browserLaunchArgs(noSandbox: boolean): string[] {
  return noSandbox ? ["--no-sandbox", "--disable-setuid-sandbox"] : [];
}

function browserNoSandbox(): boolean {
  const v = process.env.VEX_BROWSER_NO_SANDBOX?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Validate a navigation target with the same SSRF policy as web_fetch:
 *  http(s) only, and (unless private access is allowed) no metadata/private
 *  hosts. Returns the parsed URL. */
export function assertNavigableUrl(rawUrl: string, allowPrivate: boolean): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  assertWebFetchUrlAllowed(url, allowPrivate);
  return url;
}

type RefLocatorSpec =
  | { kind: "role"; role: string; name?: string; nth?: number }
  | { kind: "css"; selector: string };

/** Resolve a snapshot ref (e.g. "e1", "@e1", "ref=e1") to the locator spec it
 *  denotes, or a raw CSS selector otherwise. Throws for an unknown e-ref. */
export function resolveRefLocatorSpec(
  ref: string,
  refs: Map<string, { role: string; name?: string; nth?: number }>,
): RefLocatorSpec {
  const normalized = ref.startsWith("@")
    ? ref.slice(1)
    : ref.startsWith("ref=")
      ? ref.slice(4)
      : ref;

  if (/^e\d+$/i.test(normalized)) {
    const info = refs.get(normalized.toLowerCase());
    if (!info) {
      throw new Error(`Unknown ref "${normalized}". Run a new snapshot first.`);
    }
    return { kind: "role", role: info.role, name: info.name, nth: info.nth };
  }
  return { kind: "css", selector: ref };
}

/** Resolve element locator by ref (or CSS selector fallback). */
function getRefLocator(page: Page, ref: string, session: BrowserSession) {
  const spec = resolveRefLocatorSpec(ref, session.refs);
  if (spec.kind === "css") return page.locator(spec.selector);
  const role = spec.role as Parameters<typeof page.getByRole>[0];
  let locator = spec.name
    ? page.getByRole(role, { name: spec.name, exact: true })
    : page.getByRole(role);
  if (spec.nth !== undefined) locator = locator.nth(spec.nth);
  return locator;
}

/** Parse aria snapshot to generate element references */
export function parseAriaSnapshot(snapshot: string): Map<string, { role: string; name?: string; nth?: number }> {
  const refs = new Map<string, { role: string; name?: string; nth?: number }>();
  let refCounter = 1;
  const lines = snapshot.split("\n");
  const roleCounters = new Map<string, Map<string, number>>();

  for (const line of lines) {
    const match = line.match(/^\s*-\s+(\w+)(?:\s+"([^"]*)")?/);
    if (match) {
      const role = match[1] as string;
      const name = match[2] as string | undefined;
      const interactiveRoles = [
        "button", "link", "textbox", "checkbox", "radio", "combobox",
        "listbox", "option", "menuitem", "tab", "switch", "slider",
        "searchbox", "spinbutton", "menuitemcheckbox", "menuitemradio",
        "treeitem", "gridcell", "row", "cell"
      ];

      if (interactiveRoles.includes(role)) {
        const key = `${role}:${name || ""}`;
        if (!roleCounters.has(role)) {
          roleCounters.set(role, new Map<string, number>());
        }
        const roleMap = roleCounters.get(role)!;
        const count = roleMap.get(key) || 0;
        roleMap.set(key, count + 1);

        const refKey = `e${refCounter}`;
        refs.set(refKey, {
          role,
          name: name || undefined,
          nth: count > 0 ? count : undefined,
        });
        refCounter++;
      }
    }
  }
  return refs;
}

/** Generate ref-tagged snapshot text */
function generateRefSnapshot(refs: Map<string, { role: string; name?: string; nth?: number }>): string {
  const lines: string[] = [];
  for (const [ref, info] of refs) {
    const nameStr = info.name ? ` "${info.name}"` : "";
    const nthStr = info.nth !== undefined ? ` [${info.nth}]` : "";
    lines.push(`[${ref}] ${info.role}${nameStr}${nthStr}`);
  }
  return lines.join("\n");
}

/** Browser control tool */
export function createBrowserTool(ownerKey: string = GLOBAL_OWNER_KEY): AgentTool {
  return {
    name: "browser",
    label: "Browser Control",
    description: `Control a browser for web automation tasks.
Actions: start, stop, navigate, screenshot, snapshot, click, type, hover, drag, press, select, scroll, evaluate, wait, fill
Element Reference: After 'snapshot', use refs like 'e1', 'e2' for interactions.`,
    parameters: Type.Object({
      action: Type.String({ description: "Action: start, stop, navigate, screenshot, snapshot, click, type, hover, drag, press, select, scroll, evaluate, wait, fill" }),
      url: Type.Optional(Type.String({ description: "URL for navigate action" })),
      ref: Type.Optional(Type.String({ description: "Element ref (e.g., 'e1', 'e2') from snapshot" })),
      selector: Type.Optional(Type.String({ description: "CSS selector (fallback if ref not available)" })),
      doubleClick: Type.Optional(Type.Boolean({ description: "Double click instead of single click" })),
      button: Type.Optional(Type.String({ description: "Mouse button: left, right, middle" })),
      modifiers: Type.Optional(Type.Array(Type.String(), { description: "Modifier keys: Alt, Control, Meta, Shift" })),
      text: Type.Optional(Type.String({ description: "Text for type/press action" })),
      slowly: Type.Optional(Type.Boolean({ description: "Type slowly with delay between chars" })),
      submit: Type.Optional(Type.Boolean({ description: "Press Enter after typing" })),
      key: Type.Optional(Type.String({ description: "Key to press (e.g., 'Enter', 'Tab', 'ArrowDown')" })),
      startRef: Type.Optional(Type.String({ description: "Start element ref for drag" })),
      endRef: Type.Optional(Type.String({ description: "End element ref for drag" })),
      values: Type.Optional(Type.Array(Type.String(), { description: "Values to select in dropdown" })),
      fields: Type.Optional(Type.Array(Type.Object({
        ref: Type.String({ description: "Element ref" }),
        type: Type.String({ description: "Field type: text, checkbox, radio" }),
        value: Type.Union([Type.String(), Type.Boolean(), Type.Number()], { description: "Value to fill" }),
      }), { description: "Form fields to fill" })),
      fullPage: Type.Optional(Type.Boolean({ description: "Take full page screenshot" })),
      direction: Type.Optional(Type.String({ description: "Scroll direction: up, down, left, right" })),
      amount: Type.Optional(Type.Number({ description: "Scroll amount in pixels" })),
      waitFor: Type.Optional(Type.String({ description: "Wait condition: selector, text, load, network, timeout" })),
      value: Type.Optional(Type.String({ description: "Value for wait condition" })),
      code: Type.Optional(Type.String({ description: "JavaScript code for evaluate action" })),
      headless: Type.Optional(Type.Boolean({ description: "Run browser headless (default: true)" })),
      timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds (default: 30000)" })),
    }),
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true })!;
      const timeout = readNumberParam(params, "timeout", { min: 1000, max: 120000 }) ?? 30000;

      try {
        if (action === "start") return await startBrowser(ownerKey, params);
        if (action === "stop") return await stopBrowser(ownerKey);

        const session = getBrowserSession(ownerKey);
        switch (action) {
          case "navigate": return await navigateTo(session, params, timeout);
          case "screenshot": return await takeScreenshot(session, params, timeout);
          case "snapshot": return await getSnapshot(session, params, timeout);
          case "click": return await clickElement(session, params, timeout);
          case "type": return await typeText(session, params, timeout);
          case "hover": return await hoverElement(session, params, timeout);
          case "drag": return await dragElement(session, params, timeout);
          case "press": return await pressKey(session, params);
          case "select": return await selectOption(session, params, timeout);
          case "scroll": return await scrollPage(session, params, timeout);
          case "evaluate": return await evaluateScript(session, params, timeout);
          case "wait": return await waitFor(session, params, timeout);
          case "fill": return await fillForm(session, params, timeout);
          default: return errorResult(`Unknown action: ${action}`);
        }
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

async function startBrowser(ownerKey: string, params: Record<string, unknown>): Promise<AgentToolResult<unknown>> {
  if (browserSessions.has(ownerKey)) return jsonResult({ status: "already_running", message: "Browser is already running" });
  const headless = readBooleanParam(params, "headless") ?? true;
  const playwright = await getPlaywright();

  const browser = await playwright.chromium.launch({ headless, args: browserLaunchArgs(browserNoSandbox()) });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: "Vexlla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  browserSessions.set(ownerKey, { browser, context, page, refs: new Map(), refsMode: "role" });
  return jsonResult({ status: "started", headless, viewport: { width: 1280, height: 720 } });
}

async function stopBrowser(ownerKey: string): Promise<AgentToolResult<unknown>> {
  if (!browserSessions.has(ownerKey)) return jsonResult({ status: "not_running" });
  await disposeBrowserOwner(ownerKey);
  return jsonResult({ status: "stopped" });
}

async function navigateTo(session: BrowserSession, params: Record<string, unknown>, timeout: number): Promise<AgentToolResult<unknown>> {
  const rawUrl = readStringParam(params, "url", { required: true })!;
  // Same SSRF policy as web_fetch: no metadata/internal hosts unless explicitly
  // allowed. Note this guards the top-level navigation only; sub-resources the
  // page itself fetches are not intercepted here.
  const url = assertNavigableUrl(rawUrl, allowPrivateNetwork());
  const page = session.page;
  await page.goto(url.href, { timeout, waitUntil: "domcontentloaded" });
  session.refs.clear();
  return jsonResult({ status: "navigated", url: page.url(), title: await page.title() });
}

async function takeScreenshot(session: BrowserSession, params: Record<string, unknown>, timeout: number): Promise<AgentToolResult<unknown>> {
  const fullPage = readBooleanParam(params, "fullPage") ?? false;
  const ref = readStringParam(params, "ref");
  const selector = readStringParam(params, "selector");
  const page = session.page;
  let buffer: Buffer;
  if (ref) {
    const locator = getRefLocator(page, ref, session);
    buffer = await locator.screenshot({ type: "png", timeout });
  } else if (selector) {
    buffer = await page.locator(selector).first().screenshot({ type: "png", timeout });
  } else {
    buffer = await page.screenshot({ fullPage, type: "png" });
  }
  return jsonResult({ status: "screenshot_taken", fullPage, size: buffer.length, dataUrl: `data:image/png;base64,${buffer.toString("base64")}` });
}

async function getSnapshot(session: BrowserSession, params: Record<string, unknown>, timeout: number): Promise<AgentToolResult<unknown>> {
  const page = session.page;
  const title = await page.title();
  const url = page.url();
  let ariaSnapshot = "";
  try { ariaSnapshot = await page.locator("body").ariaSnapshot(); } catch {}
  if (ariaSnapshot) {
    const refs = parseAriaSnapshot(ariaSnapshot);
    session.refs = refs;
    return jsonResult({ status: "snapshot", url, title, elementsCount: refs.size, elements: generateRefSnapshot(refs), ariaSnapshot: ariaSnapshot.slice(0, 8000) });
  }
  type InteractiveElement = { ref: string; tag: string; type: string; text: string };
  const interactiveElements: InteractiveElement[] = await page.evaluate(`(() => {
    const elements = [];
    const selectors = 'a, button, input, textarea, select, [role="button"], [role="link"], [role="textbox"]';
    const els = document.querySelectorAll(selectors);
    let index = 1;
    els.forEach(el => {
      if (index > 50) return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      elements.push({ ref: 'e' + index, tag: el.tagName.toLowerCase(), type: el.type || el.getAttribute('role') || '', text: (el.innerText || el.value || '').slice(0, 50) });
      index++;
    });
    return elements;
  })()`);
  session.refs.clear();
  for (const el of interactiveElements) session.refs.set(el.ref, { role: el.tag === "a" ? "link" : el.tag === "button" ? "button" : el.type || el.tag, name: el.text });
  return jsonResult({ status: "snapshot", url, title, elements: interactiveElements, elementsCount: interactiveElements.length });
}

async function clickElement(session: BrowserSession, params: Record<string, unknown>, timeout: number): Promise<AgentToolResult<unknown>> {
  const ref = readStringParam(params, "ref");
  const selector = readStringParam(params, "selector");
  if (!ref && !selector) return errorResult("Either 'ref' or 'selector' is required");
  const page = session.page;
  const locator = ref ? getRefLocator(page, ref, session) : page.locator(selector!);
  const doubleClick = readBooleanParam(params, "doubleClick") ?? false;
  const button = readStringParam(params, "button") as "left" | "right" | "middle" | undefined;
  if (doubleClick) await locator.dblclick({ timeout, button: button || "left" });
  else await locator.click({ timeout, button: button || "left" });
  return jsonResult({ status: "clicked", element: ref || selector });
}

async function typeText(session: BrowserSession, params: Record<string, unknown>, timeout: number): Promise<AgentToolResult<unknown>> {
  const ref = readStringParam(params, "ref");
  const selector = readStringParam(params, "selector");
  const text = readStringParam(params, "text", { required: true })!;
  if (!ref && !selector) return errorResult("Either 'ref' or 'selector' is required");
  const page = session.page;
  const locator = ref ? getRefLocator(page, ref, session) : page.locator(selector!);
  const slowly = readBooleanParam(params, "slowly") ?? false;
  const submit = readBooleanParam(params, "submit") ?? false;
  if (slowly) { await locator.click({ timeout }); await locator.type(text, { timeout, delay: 75 }); }
  else await locator.fill(text, { timeout });
  if (submit) await locator.press("Enter", { timeout });
  return jsonResult({ status: "typed", element: ref || selector, text: text.slice(0, 50), submitted: submit });
}

async function hoverElement(session: BrowserSession, params: Record<string, unknown>, timeout: number): Promise<AgentToolResult<unknown>> {
  const ref = readStringParam(params, "ref");
  const selector = readStringParam(params, "selector");
  if (!ref && !selector) return errorResult("Either 'ref' or 'selector' is required");
  const page = session.page;
  const locator = ref ? getRefLocator(page, ref, session) : page.locator(selector!);
  await locator.hover({ timeout });
  return jsonResult({ status: "hovered", element: ref || selector });
}

async function dragElement(session: BrowserSession, params: Record<string, unknown>, timeout: number): Promise<AgentToolResult<unknown>> {
  const startRef = readStringParam(params, "startRef", { required: true })!;
  const endRef = readStringParam(params, "endRef", { required: true })!;
  const page = session.page;
  await getRefLocator(page, startRef, session).dragTo(getRefLocator(page, endRef, session), { timeout });
  return jsonResult({ status: "dragged", from: startRef, to: endRef });
}

async function pressKey(session: BrowserSession, params: Record<string, unknown>): Promise<AgentToolResult<unknown>> {
  const key = readStringParam(params, "key", { required: true })!;
  await (session.page as any).keyboard.press(key);
  return jsonResult({ status: "pressed", key });
}

async function selectOption(session: BrowserSession, params: Record<string, unknown>, timeout: number): Promise<AgentToolResult<unknown>> {
  const ref = readStringParam(params, "ref");
  const selector = readStringParam(params, "selector");
  const values = params.values as string[] | undefined;
  if (!ref && !selector) return errorResult("Either 'ref' or 'selector' is required");
  if (!values?.length) return errorResult("'values' array is required");
  const page = session.page;
  const locator = ref ? getRefLocator(page, ref, session) : page.locator(selector!);
  await locator.selectOption(values, { timeout });
  return jsonResult({ status: "selected", element: ref || selector, values });
}

async function scrollPage(session: BrowserSession, params: Record<string, unknown>, timeout: number): Promise<AgentToolResult<unknown>> {
  const ref = readStringParam(params, "ref");
  const direction = readStringParam(params, "direction") ?? "down";
  const amount = readNumberParam(params, "amount", { min: 100, max: 10000 }) ?? 500;
  const page = session.page;
  if (ref) { await getRefLocator(page, ref, session).scrollIntoViewIfNeeded({ timeout }); return jsonResult({ status: "scrolled", element: ref }); }
  const deltas: Record<string, [number, number]> = { up: [0, -amount], down: [0, amount], left: [-amount, 0], right: [amount, 0] };
  const [dx, dy] = deltas[direction] ?? [0, amount];
  await page.evaluate(`window.scrollBy(${dx}, ${dy})`);
  return jsonResult({ status: "scrolled", direction, amount });
}

async function evaluateScript(session: BrowserSession, params: Record<string, unknown>, timeout: number): Promise<AgentToolResult<unknown>> {
  const code = readStringParam(params, "code", { required: true })!;
  const ref = readStringParam(params, "ref");
  const page = session.page;
  const result = ref ? await getRefLocator(page, ref, session).evaluate((el: any, c: string) => eval(c), code) : await page.evaluate(code);
  return jsonResult({ status: "evaluated", result: JSON.stringify(result, null, 2).slice(0, 2000) });
}

async function waitFor(session: BrowserSession, params: Record<string, unknown>, timeout: number): Promise<AgentToolResult<unknown>> {
  const waitForCondition = readStringParam(params, "waitFor") ?? "timeout";
  const value = readStringParam(params, "value");
  const page = session.page;
  switch (waitForCondition) {
    case "selector": if (!value) return errorResult("Selector required"); await page.waitForSelector(value, { timeout }); return jsonResult({ status: "waited", condition: "selector" });
    case "text": if (!value) return errorResult("Text required"); await page.getByText(value).first().waitFor({ state: "visible", timeout }); return jsonResult({ status: "waited", condition: "text" });
    case "load": await page.waitForLoadState("load", { timeout }); return jsonResult({ status: "waited", condition: "load" });
    case "network": await page.waitForLoadState("networkidle", { timeout }); return jsonResult({ status: "waited", condition: "networkidle" });
    default: await page.waitForTimeout(readNumberParam(params, "amount") ?? 1000); return jsonResult({ status: "waited", condition: "timeout" });
  }
}

async function fillForm(session: BrowserSession, params: Record<string, unknown>, timeout: number): Promise<AgentToolResult<unknown>> {
  const fields = params.fields as Array<{ ref: string; type: string; value: string | boolean | number }> | undefined;
  if (!fields?.length) return errorResult("'fields' array is required");
  const page = session.page;
  const results: Array<{ ref: string; status: string }> = [];
  for (const field of fields) {
    if (!field.ref || !field.type) { results.push({ ref: field.ref || "unknown", status: "skipped" }); continue; }
    try {
      const locator = getRefLocator(page, field.ref, session);
      if (field.type === "checkbox" || field.type === "radio") await locator.setChecked(field.value === true || field.value === "true", { timeout });
      else await locator.fill(String(field.value), { timeout });
      results.push({ ref: field.ref, status: "filled" });
    } catch (e) { results.push({ ref: field.ref, status: `error: ${e}` }); }
  }
  return jsonResult({ status: "form_filled", fields: results });
}
