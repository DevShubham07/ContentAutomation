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
 * Wait for Gemini to finish generating images in the response.
 */
async function waitForGeminiResponse(page, timeoutMs = GENERATION_TIMEOUT_MS) {
  const start = Date.now();
  const POLL_MS = 3_000;

  console.log(`[${STEP_NAME}] Waiting for Gemini response...`);

  while (Date.now() - start < timeoutMs) {
    const result = await page.evaluate(() => {
      // Look for images in the page that are likely generated content
      const imgs = document.querySelectorAll("img");
      let foundGenerated = false;

      for (const img of imgs) {
        const src = img.src || "";
        // Skip small images (icons, avatars, logos)
        if (img.naturalWidth < 100 || img.naturalHeight < 100) continue;
        // Skip known UI images
        if (src.includes("avatar") || src.includes("icon") || src.includes("logo")) continue;
        if (src.includes("data:image/svg")) continue;
        // Generated images are typically from Google CDN
        if (
          src.includes("googleusercontent.com") ||
          src.includes("gstatic.com") ||
          src.includes("ggpht.com") ||
          src.includes("lh3.google") ||
          (img.naturalWidth >= 200 && img.naturalHeight >= 200)
        ) {
          foundGenerated = true;
        }
      }

      // Check if Gemini refused
      const bodyText = document.body.innerText || "";
      if (
        bodyText.includes("I can't generate") ||
        bodyText.includes("I'm not able to generate") ||
        bodyText.includes("unable to create")
      ) {
        return "refused";
      }

      return foundGenerated ? "done" : "waiting";
    });

    if (result === "refused") {
      throw new Error("Gemini refused to generate the image");
    }
    if (result === "done") {
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

  console.warn(`[${STEP_NAME}] Timed out after ${timeoutMs / 1000}s`);
}

/**
 * Extract the best (largest) generated image URL from the page.
 */
async function extractImageUrl(page) {
  return page.evaluate(() => {
    const imgs = document.querySelectorAll("img");
    let bestUrl = null;
    let bestSize = 0;

    for (const img of imgs) {
      const src = img.src || "";
      if (img.naturalWidth < 100 || img.naturalHeight < 100) continue;
      if (src.includes("avatar") || src.includes("icon") || src.includes("logo")) continue;
      if (src.includes("data:image/svg")) continue;

      const size = img.naturalWidth * img.naturalHeight;
      if (size > bestSize) {
        bestSize = size;
        bestUrl = src;
      }
    }
    return bestUrl;
  });
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

// ... [existing imports] ...

export async function generateImages(context, frames) {
  if (!context || !Array.isArray(frames) || frames.length === 0) {
    throw new Error("context and non-empty frames array are required");
  }

  const framesDir = path.resolve(process.cwd(), FRAMES_DIR);
  await fs.ensureDir(framesDir);

  const page = await getOrReusePage(context, "https://gemini.google.com");
  try {
    console.log(`[${STEP_NAME}] Navigating to Gemini...`);
    await page.goto(GEMINI_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await humanDelay(3000, 5000);

    for (let i = 0; i < frames.length; i++) {
      const prompt = frames[i];
      const filename = `frame_${formatFrameIndex(i)}.png`;
      const destPath = path.join(framesDir, filename);

      if (await fs.pathExists(destPath)) {
        console.log(`[${STEP_NAME}] Frame ${i + 1}/${frames.length} exists, skipping.`);
        continue;
      }

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
      const fullPrompt = `Generate an image of: ${prompt}`;
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

      // Wait for generation
      await waitForGeminiResponse(page, GENERATION_TIMEOUT_MS);

      // Extract and download image
      const imageUrl = await extractImageUrl(page);
      if (!imageUrl) throw new Error("No image found in Gemini response");

      const bytes = await downloadImage(page, imageUrl, destPath);
      console.log(`[${STEP_NAME}] ✅ Frame ${i + 1}: ${filename} (${bytes} bytes)`);

      if (i < frames.length - 1) await humanDelay(3000, 5000);
    }
  } finally {
    await page.close();
  }
}
