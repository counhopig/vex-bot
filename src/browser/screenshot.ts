/**
 * Screenshot enhancement features
 *
 * Based on moltbot's screenshot.ts and pw-tools-core.snapshot.ts implementation
 * Supports screenshot compression, labeled screenshots, and more
 */

import type { ScreenshotOptions, ScreenshotResult, SnapshotOptions, SnapshotResult } from "./types.js";
import { requireSession, getRefLocator, parseAriaSnapshot } from "./session.js";

/** Default maximum screenshot side length */
const DEFAULT_MAX_SIDE = 2000;
/** Default maximum screenshot bytes */
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Normalize screenshot - compress to fit AI model limits
 */
export async function normalizeScreenshot(
  buffer: Buffer,
  options?: {
    maxSide?: number;
    maxBytes?: number;
  }
): Promise<ScreenshotResult> {
  const maxSide = options?.maxSide ?? DEFAULT_MAX_SIDE;
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;

  // If already within limits, return as-is
  if (buffer.byteLength <= maxBytes) {
    return {
      buffer,
      contentType: "image/png",
      compressed: false,
    };
  }

  // Try compressing with sharp (if available)
  try {
    // @ts-ignore - sharp is an optional dependency
    const sharpModule = await import("sharp");
    const sharp = sharpModule.default;
    const metadata = await sharp(buffer).metadata();
    const width = metadata.width || 1280;
    const height = metadata.height || 720;
    const maxDim = Math.max(width, height);

    // Quality gradient
    const qualities = [85, 75, 65, 55, 45, 35];
    // Size gradient
    const sideSteps = [maxSide, 1800, 1600, 1400, 1200, 1000, 800];

    for (const targetSide of sideSteps) {
      if (maxDim <= targetSide) continue;

      for (const quality of qualities) {
        const scale = targetSide / maxDim;
        const newWidth = Math.round(width * scale);
        const newHeight = Math.round(height * scale);

        const result = await sharp(buffer)
          .resize(newWidth, newHeight, { fit: "inside" })
          .jpeg({ quality })
          .toBuffer();

        if (result.byteLength <= maxBytes) {
          return {
            buffer: result,
            contentType: "image/jpeg",
            originalSize: { width, height },
            compressed: true,
          };
        }
      }
    }

    // Last resort: lowest quality
    const result = await sharp(buffer)
      .resize(800, 600, { fit: "inside" })
      .jpeg({ quality: 30 })
      .toBuffer();

    return {
      buffer: result,
      contentType: "image/jpeg",
      originalSize: { width, height },
      compressed: true,
    };
  } catch {
    // sharp not available, return original
    return {
      buffer,
      contentType: "image/png",
      compressed: false,
    };
  }
}

/**
 * Take a screenshot of a page or element
 */
export async function takeScreenshot(
  options?: ScreenshotOptions,
  profileName = "default"
): Promise<ScreenshotResult> {
  const session = requireSession(profileName);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const page = session.page as any;

  const {
    fullPage = false,
    ref,
    selector,
    format = "png",
    quality,
    withLabels = false,
    maxLabels = 50,
  } = options || {};

  let buffer: Buffer;

  if (ref) {
    const locator = getRefLocator(page, ref, session);
    buffer = await locator.screenshot({ type: format, quality });
  } else if (selector) {
    const locator = page.locator(selector).first();
    buffer = await locator.screenshot({ type: format, quality });
  } else if (withLabels && session.refs.size > 0) {
    // Labeled screenshot
    buffer = await takeScreenshotWithLabels(page, session, maxLabels, format);
  } else {
    buffer = await page.screenshot({ fullPage, type: format, quality });
  }

  // Normalize screenshot
  return normalizeScreenshot(buffer);
}

/** Element box position information */
interface BoxInfo {
  ref: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Labeled screenshot - draws reference labels on interactive elements
 */
async function takeScreenshotWithLabels(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  session: any,
  maxLabels: number,
  format: "png" | "jpeg"
): Promise<Buffer> {
  const refsArray = Array.from(session.refs.entries() as Iterable<[string, { role: string; name?: string; nth?: number }]>);
  const refs = refsArray.slice(0, maxLabels);

  // Collect element positions
  const boxes: BoxInfo[] = [];

  for (const [ref, info] of refs) {
    try {
      const locator = info.name
        ? page.getByRole(info.role, { name: info.name, exact: true })
        : page.getByRole(info.role);

      const finalLocator = info.nth !== undefined ? locator.nth(info.nth) : locator;
      const box = await finalLocator.boundingBox({ timeout: 1000 });

      if (box && box.width > 0 && box.height > 0) {
        boxes.push({ ref, x: box.x, y: box.y, width: box.width, height: box.height });
      }
    } catch {
      // Ignore elements whose positions could not be obtained
    }
  }

  // Inject labels into the page (use string form to avoid DOM type issues)
  await page.evaluate(`
    (function(boxes) {
      // Remove old labels
      var oldRoot = document.querySelector("[data-vex-labels]");
      if (oldRoot) oldRoot.remove();

      var root = document.createElement("div");
      root.setAttribute("data-vex-labels", "1");
      root.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none";

      for (var i = 0; i < boxes.length; i++) {
        var box = boxes[i];
        // Border
        var border = document.createElement("div");
        border.style.cssText = "position:fixed;left:" + box.x + "px;top:" + box.y + "px;width:" + box.width + "px;height:" + box.height + "px;border:2px solid #ffb020;box-sizing:border-box;pointer-events:none";
        root.appendChild(border);

        // Label
        var label = document.createElement("div");
        label.textContent = box.ref;
        label.style.cssText = "position:fixed;left:" + box.x + "px;top:" + Math.max(0, box.y - 16) + "px;background:#ffb020;color:#000;font:bold 10px sans-serif;padding:1px 3px;border-radius:2px;pointer-events:none";
        root.appendChild(label);
      }

      document.documentElement.appendChild(root);
    })(${JSON.stringify(boxes)})
  `);

  // Take screenshot
  const buffer = await page.screenshot({ type: format });

  // Remove labels
  await page.evaluate(`
    (function() {
      var root = document.querySelector("[data-vex-labels]");
      if (root) root.remove();
    })()
  `);

  return buffer;
}

/**
 * Get a page snapshot
 */
export async function getPageSnapshot(
  options?: SnapshotOptions,
  profileName = "default"
): Promise<SnapshotResult> {
  const session = requireSession(profileName);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const page = session.page as any;

  const {
    maxChars = 80000,
    selector = "body",
  } = options || {};

  const title = await page.title();
  const url = page.url();

  // Try using ariaSnapshot API
  let ariaSnapshot = "";
  try {
    ariaSnapshot = await page.locator(selector).ariaSnapshot();
  } catch {
    // ariaSnapshot not supported, fall back to traditional method
  }

  if (ariaSnapshot) {
    const refs = parseAriaSnapshot(ariaSnapshot);
    session.refs = refs;
    session.refsMode = "role";

    // Truncate
    const truncated = ariaSnapshot.length > maxChars;
    const truncatedSnapshot = truncated
      ? ariaSnapshot.slice(0, maxChars) + "\n...[truncated]"
      : ariaSnapshot;

    return {
      url,
      title,
      ariaSnapshot: truncatedSnapshot,
      refs,
      elementsCount: refs.size,
      truncated,
    };
  }

  // Traditional method: extract interactive elements (use string form to avoid DOM type issues)
  const elements = await page.evaluate(`
    (function() {
      var result = [];
      var selectors = 'a, button, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="radio"], [onclick]';
      var els = document.querySelectorAll(selectors);
      var index = 1;

      for (var i = 0; i < els.length; i++) {
        if (index > 100) break;
        var el = els[i];
        var rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;

        result.push({
          ref: 'e' + index,
          tag: el.tagName.toLowerCase(),
          type: el.type || el.getAttribute('role') || '',
          text: ((el.innerText || el.value || el.placeholder || el.getAttribute('aria-label')) || '').slice(0, 50),
          name: el.name || '',
          id: el.id || ''
        });
        index++;
      }

      return result;
    })()
  `) as Array<{
    ref: string;
    tag: string;
    type: string;
    text: string;
    name: string;
    id: string;
  }>;

  // Update refs
  session.refs.clear();
  for (const el of elements) {
    session.refs.set(el.ref, {
      role: el.tag === "a" ? "link" : el.tag === "button" ? "button" : el.type || el.tag,
      name: el.text || el.name || el.id || undefined,
    });
  }

  return {
    url,
    title,
    refs: session.refs,
    elementsCount: elements.length,
    truncated: false,
  };
}
