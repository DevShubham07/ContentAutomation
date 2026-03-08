import path from "node:path";
import fs from "fs-extra";
import { retry } from "../utils/retry.js";
import { humanDelay } from "../utils/delay.js";
import { waitForNetworkIdle } from "../utils/networkIdle.js";
import { classifyStepError, inferLoginRequired } from "../utils/stepGuards.js";

const STEP_NAME = "generateImages";
const GROK_IMAGINE_URL = "https://grok.com/imagine";
const FRAMES_DIR = "./assets/frames";

// How many frames to generate at a time (Grok generates 4 images per prompt)
const GENERATION_TIMEOUT_MS = 120_000;

// -- Selectors matching the actual Grok /imagine UI --
const SELECTORS = {
  // Prompt input — Grok uses a tiptap contenteditable div
  promptInput: ".tiptap, div[contenteditable='true'], textarea",
  // Submit button
  submitButton: "button[aria-label='Submit'], button[type='submit']",
  // Redo button signals generation is complete
  redoButton: "text=Redo",
  // Progress indicator
  progressIndicator: "div.tabular-nums",
};

function formatFrameIndex(index) {
  return String(index).padStart(4, "0");
}

/**
 * Fill the prompt in a contenteditable div or textarea.
 * For tiptap (contenteditable), we use JS injection since .fill() doesn't work
 * reliably on contenteditable divs.
 */
async function fillPromptInput(page, promptInput, text) {
  await promptInput.focus();
  await promptInput.evaluate((el, value) => {
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      // contenteditable div (tiptap)
      el.innerText = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }, text);
}

/**
 * Wait for image generation to complete on Grok.
 * Detection:
 *  1. "Redo" button appears → definitive signal
 *  2. Progress indicator disappears after being visible → done
 *  3. Timeout fallback
 */
async function waitForGenerationComplete(page, timeoutMs = GENERATION_TIMEOUT_MS) {
  const start = Date.now();
  const POLL_MS = 3_000;
  let sawProgress = false;

  console.log(`[${STEP_NAME}] Polling for generation completion...`);

  while (Date.now() - start < timeoutMs) {
    // Check 1: Redo button is definitive
    try {
      const redoBtn = page.getByText("Redo", { exact: true });
      if (await redoBtn.isVisible().catch(() => false)) {
        console.log(`[${STEP_NAME}] "Redo" button appeared — generation complete.`);
        return;
      }
    } catch { }

    // Check 2: Track progress indicator
    try {
      const pctEl = page.locator(SELECTORS.progressIndicator).first();
      if (await pctEl.isVisible().catch(() => false)) {
        const pctText = await pctEl.innerText().catch(() => "");
        sawProgress = true;
        console.log(`[${STEP_NAME}]   Progress: ${pctText}`);
      } else if (sawProgress) {
        console.log(`[${STEP_NAME}] Progress indicator disappeared — generation likely complete.`);
        return;
      }
    } catch { }

    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  console.warn(`[${STEP_NAME}] Generation wait timed out after ${timeoutMs / 1000}s — attempting extraction anyway.`);
}

/**
 * Extract generated image URLs from the page.
 * Grok serves generated images from assets.grok.com.
 * We look for <img> elements whose src contains "assets.grok.com".
 */
async function extractGeneratedImageUrls(page) {
  return page.evaluate(() => {
    const imgs = document.querySelectorAll("img");
    const urls = [];
    for (const img of imgs) {
      const src = img.src || "";
      if (src.includes("assets.grok.com") && !urls.includes(src)) {
        urls.push(src);
      }
    }
    return urls;
  });
}

/**
 * Download an image from a URL using Playwright's request context.
 */
async function downloadImage(context, url, destPath) {
  const response = await context.request.get(url);
  if (response.status() !== 200) {
    throw new Error(`HTTP ${response.status()} downloading ${url.slice(0, 80)}`);
  }
  const buffer = await response.body();
  await fs.writeFile(destPath, buffer);
  return buffer.length;
}

export async function generateImages(context, frames) {
  if (!context || !Array.isArray(frames) || frames.length === 0) {
    throw new Error("context and non-empty frames array are required");
  }

  const framesDir = path.resolve(process.cwd(), FRAMES_DIR);
  await fs.ensureDir(framesDir);

  let globalFrameIndex = 0;

  // Process frames one prompt at a time.
  // Grok generates multiple images per prompt — we pick the first (best match)
  // and use it for the frame.
  for (let i = 0; i < frames.length; i++) {
    const prompt = frames[i];
    const filename = `frame_${formatFrameIndex(i)}.png`;
    const destPath = path.join(framesDir, filename);

    // Skip if already generated (resume support)
    if (await fs.pathExists(destPath)) {
      console.log(`[${STEP_NAME}] Frame ${i + 1}/${frames.length} already exists, skipping.`);
      continue;
    }

    await retry(async () => {
      const page = await context.newPage();

      try {
        console.log(`[${STEP_NAME}] Generating frame ${i + 1}/${frames.length}...`);

        // Navigate to Grok /imagine
        await page.goto(GROK_IMAGINE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await waitForNetworkIdle(page, 15_000);
        await humanDelay(2000, 4000);

        // Wait for the prompt input to appear
        const promptInput = page.locator(SELECTORS.promptInput).first();
        try {
          await promptInput.waitFor({ state: "visible", timeout: 30_000 });
        } catch (err) {
          const loginRequired = await inferLoginRequired(page);
          if (loginRequired) {
            throw new Error("Login required on Grok (prompt input not available)");
          }
          throw err;
        }
        await humanDelay(500, 1000);

        // Fill the prompt using JS injection (works with tiptap contenteditable)
        await fillPromptInput(page, promptInput, prompt);
        await humanDelay(500, 1000);

        // Submit via Enter key (primary) + fallback to submit button click
        console.log(`[${STEP_NAME}] Submitting prompt...`);
        await page.keyboard.press("Enter");
        await humanDelay(1000, 2000);

        // Fallback: click submit button if still visible
        try {
          const submitBtn = page.locator(SELECTORS.submitButton).last();
          if (await submitBtn.isVisible().catch(() => false) && await submitBtn.isEnabled().catch(() => false)) {
            console.log(`[${STEP_NAME}] Clicking submit button as fallback...`);
            await submitBtn.click();
          }
        } catch { }

        // Wait for navigation (Grok navigates to /imagine/post/... after submission)
        try {
          await page.waitForURL("**/imagine/**", { timeout: 15_000 });
          console.log(`[${STEP_NAME}] Navigated to: ${page.url()}`);
        } catch {
          console.log(`[${STEP_NAME}] URL unchanged: ${page.url()} — proceeding anyway.`);
        }
        await humanDelay(2000, 3000);

        // Wait for generation to complete
        await waitForGenerationComplete(page, GENERATION_TIMEOUT_MS);
        await humanDelay(3000, 5000);

        // Extract generated image URLs
        const imageUrls = await extractGeneratedImageUrls(page);
        console.log(`[${STEP_NAME}] Found ${imageUrls.length} generated image(s).`);

        if (imageUrls.length === 0) {
          throw new Error("No generated images found on the page");
        }

        // Download the first generated image (best match for the prompt)
        const url = imageUrls[0];
        console.log(`[${STEP_NAME}] Downloading image from: ${url.slice(0, 80)}...`);
        const bytes = await downloadImage(context, url, destPath);
        console.log(`[${STEP_NAME}] Frame ${i + 1} saved: ${filename} (${bytes} bytes)`);

      } catch (err) {
        const msg = classifyStepError(STEP_NAME, err);
        throw new Error(`${msg} (frame ${i + 1})`);
      } finally {
        await page.close();
      }
    }, 3, 3000);

    if (i < frames.length - 1) {
      await humanDelay(2000, 4000);
    }
  }
}
