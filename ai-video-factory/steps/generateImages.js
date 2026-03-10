import path from "node:path";
import fs from "fs-extra";
import { humanDelay } from "../utils/delay.js";

const STEP_NAME = "generateImages";
const GEMINI_URL = "https://gemini.google.com/app";
const FRAMES_DIR = "./assets/frames";
const GENERATION_TIMEOUT_MS = 120_000;

function formatFrameIndex(index) {
  return String(index).padStart(4, "0");
}

/**
 * Wait for Gemini to finish generating an image in the LATEST response.
 * Instead of counting all images on the page (unreliable), this:
 * 1. Waits for the loading indicator to disappear
 * 2. Checks the LAST model response for a large image
 */
async function waitForGeminiResponse(page, _expectedImageCount = 1, timeoutMs = GENERATION_TIMEOUT_MS) {
  const start = Date.now();
  const POLL_MS = 3_000;

  console.log(`[${STEP_NAME}] Waiting for Gemini response...`);

  while (Date.now() - start < timeoutMs) {
    const result = await page.evaluate(() => {
      // Check if Gemini is still loading/streaming
      // Common selectors: loading dots, spinner, "thinking" indicator
      const loadingSelectors = [
        '.loading-indicator', '.thinking', '[aria-label*="Loading"]',
        '.model-response-loading', 'mat-progress-bar',
        '.response-streaming', '[class*="loading"]',
      ];
      for (const sel of loadingSelectors) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) return 'loading';
      }

      // Check if Gemini refused
      const bodyText = document.body.innerText || '';
      if (
        bodyText.includes("I can't generate") ||
        bodyText.includes("I'm not able to generate") ||
        bodyText.includes("unable to create") ||
        bodyText.includes("I'm unable to")
      ) {
        return 'refused';
      }

      // Find the LAST model response container
      // Gemini uses turns — each response is in a container with model attribution
      const allTurns = document.querySelectorAll(
        'model-response, .model-response-text, [data-turn-role="model"], message-content'
      );
      const lastTurn = allTurns.length > 0 ? allTurns[allTurns.length - 1] : null;

      // Also try a broader approach: find the last container with a large image
      const searchRoot = lastTurn || document;
      const imgs = searchRoot.querySelectorAll('img');

      for (const img of imgs) {
        if (img.naturalWidth >= 200 && img.naturalHeight >= 200) {
          const src = img.src || '';
          if (src.includes('avatar') || src.includes('icon') || src.includes('logo')) continue;
          if (src.includes('data:image/svg')) continue;
          return 'done';
        }
      }

      // Broader fallback: check ALL images on page for any new large generated image
      const allImgs = document.querySelectorAll('img');
      let largeCount = 0;
      for (const img of allImgs) {
        if (img.naturalWidth >= 300 && img.naturalHeight >= 300) {
          const src = img.src || '';
          if (src.includes('avatar') || src.includes('icon') || src.includes('logo')) continue;
          if (src.includes('data:image/svg')) continue;
          largeCount++;
        }
      }
      // If there are large images on the page, consider it done
      if (largeCount > 0) return 'done';

      return 'waiting';
    });

    if (result === 'refused') {
      throw new Error('Gemini refused to generate the image');
    }
    if (result === 'done') {
      console.log(`[${STEP_NAME}] Image found in response.`);
      await humanDelay(3000, 5000);
      return;
    }

    const elapsed = Math.round((Date.now() - start) / 1000);
    if (elapsed % 15 === 0 && elapsed > 0) {
      console.log(`[${STEP_NAME}]   Still generating... (${elapsed}s)`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  // Don't throw — we'll try to extract whatever we can
  console.warn(`[${STEP_NAME}] Timed out after ${timeoutMs / 1000}s, will attempt extraction anyway`);
}

/**
 * Extract the generated image URL from the page.
 * Looks at ALL large images and picks the best one not in excludeUrls.
 */
async function extractImageUrl(page, excludeUrls = new Set()) {
  const excludeArray = Array.from(excludeUrls);
  return page.evaluate(({ excludeArray }) => {
    const imgs = document.querySelectorAll('img');
    let bestUrl = null;
    let bestSize = 0;

    for (const img of imgs) {
      const src = img.src || '';
      // Skip tiny images
      if (img.naturalWidth < 200 || img.naturalHeight < 200) continue;
      // Skip UI elements
      if (src.includes('avatar') || src.includes('icon') || src.includes('logo')) continue;
      if (src.includes('data:image/svg')) continue;
      if (src.includes('emoji') || src.includes('flag')) continue;
      // Skip already-downloaded images
      if (excludeArray.some((u) => src === u)) continue;

      const size = img.naturalWidth * img.naturalHeight;
      if (size > bestSize) {
        bestSize = size;
        bestUrl = src;
      }
    }
    return bestUrl;
  }, { excludeArray });
}

/**
 * Download image. Bypasses CORS by using Playwright's request context,
 * with a fallback to screenshotting the DOM element directly.
 */
async function downloadImage(page, url, destPath) {
  try {
    // Attempt 1: Node.js side request (bypasses page CORS)
    const response = await page.context().request.get(url);
    if (response.ok()) {
      const buffer = await response.body();
      await fs.writeFile(destPath, buffer);
      return buffer.length;
    }
  } catch (err) {
    console.warn(`[${STEP_NAME}] Context request failed, falling back to screenshot: ${err.message}`);
  }

  // Attempt 2: Screenshot the element directly from the page
  console.log(`[${STEP_NAME}] Taking element screenshot fallback...`);
  const imgHandle = await page.evaluateHandle((src) => {
    return Array.from(document.querySelectorAll("img")).find((i) => i.src === src);
  }, url);

  if (!imgHandle) {
    throw new Error("Could not find generated image element in DOM.");
  }

  await imgHandle.screenshot({ path: destPath });
  await imgHandle.dispose();
  const stat = await fs.stat(destPath);
  return stat.size;
}

/**
 * Generate images using Gemini via the local system Chrome.
 * Uses the `context` provided by the pipeline which is already connected
 * to the logged-in Chrome instance on port 9222.
 */
import { getOrReusePage } from "../utils/browser.js";

export async function generateImages(context, frames) {
  if (!context || !Array.isArray(frames) || frames.length === 0) {
    throw new Error("context and non-empty frames array are required");
  }

  const framesDir = path.resolve(process.cwd(), FRAMES_DIR);
  await fs.emptyDir(framesDir); // Always start fresh

  const page = await getOrReusePage(context, "https://gemini.google.com");
  const downloadedUrls = new Set(); // Track URLs we already saved

  try {
    console.log(`[${STEP_NAME}] Navigating to Gemini...`);
    await page.goto(GEMINI_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await humanDelay(3000, 5000);

    for (let i = 0; i < frames.length; i++) {
      const prompt = frames[i];
      const filename = `frame_${formatFrameIndex(i)}.png`;
      const destPath = path.join(framesDir, filename);

      console.log(`[${STEP_NAME}] Frame ${i + 1}/${frames.length}...`);

      // Check if logged in — look for the prompt input
      const inputSelectors = [
        "div.ql-editor",
        "rich-textarea div[contenteditable='true']",
        "div[contenteditable='true']",
        "textarea",
      ];

      let promptInput = null;
      for (const sel of inputSelectors) {
        const el = page.locator(sel).first();
        try {
          if (await el.isVisible({ timeout: 5000 })) {
            promptInput = el;
            break;
          }
        } catch { }
      }

      if (!promptInput) {
        throw new Error(
          `LOGIN_REQUIRED: Log into Google in your local Chrome first. Run: npm run login`
        );
      }

      // Type prompt
      const fullPrompt = `Generate a PORTRAIT image (9:16 aspect ratio, vertical orientation like an Instagram Reel). The image should depict: ${prompt}`;
      console.log(`[${STEP_NAME}] Prompt: ${fullPrompt.slice(0, 80)}...`);

      await promptInput.focus();
      await promptInput.evaluate((el, text) => {
        if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
          el.value = text;
          el.dispatchEvent(new Event("input", { bubbles: true }));
        } else {
          el.innerText = text;
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }, fullPrompt);
      await humanDelay(500, 1000);

      // Send
      const sendBtnSelectors = [
        "button[aria-label='Send message']",
        "button[aria-label='Send']",
        "button.send-button",
        ".send-button-container button",
      ];
      let sent = false;
      for (const sel of sendBtnSelectors) {
        const btn = page.locator(sel).first();
        try {
          if (await btn.isVisible({ timeout: 2000 }) && await btn.isEnabled()) {
            await btn.click();
            sent = true;
            break;
          }
        } catch { }
      }
      if (!sent) await page.keyboard.press("Enter");

      await humanDelay(2000, 3000);

      // Wait for generation — expect i+1 total images on page
      await waitForGeminiResponse(page, i + 1, GENERATION_TIMEOUT_MS);

      // Extract image, excluding ones we already downloaded
      const imageUrl = await extractImageUrl(page, downloadedUrls);
      if (!imageUrl) throw new Error("No NEW image found in Gemini response");

      downloadedUrls.add(imageUrl);

      const bytes = await downloadImage(page, imageUrl, destPath);
      console.log(`[${STEP_NAME}] ✅ Frame ${i + 1}: ${filename} (${bytes} bytes)`);

      if (i < frames.length - 1) await humanDelay(3000, 5000);
    }
  } catch (err) {
    // Don't close the reused tab — leave it for future runs
    throw err;
  }
}
