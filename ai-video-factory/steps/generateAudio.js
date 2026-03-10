import path from "node:path";
import fs from "fs-extra";
import { retry } from "../utils/retry.js";
import { humanDelay } from "../utils/delay.js";
import { waitForNetworkIdle } from "../utils/networkIdle.js";
import { classifyStepError, inferLoginRequired } from "../utils/stepGuards.js";
import { getOrReusePage } from "../utils/browser.js";

const STEP_NAME = "generateAudio";
const ELEVENLABS_URL = "https://elevenlabs.io/app/speech-synthesis/text-to-speech";
const AUDIO_DIR = "./assets/audio";
const OUTPUT_PATH = "./assets/audio/narration.mp3";
const LOGIN_WAIT_MS = 300_000;
const GENERATION_TIMEOUT_MS = 120_000;
const SCREENSHOTS_DIR = "./assets/debug-screenshots";

/**
 * Take a debug screenshot.
 */
async function debugScreenshot(page, label) {
  try {
    const dir = path.resolve(process.cwd(), SCREENSHOTS_DIR);
    await fs.ensureDir(dir);
    const filepath = path.join(dir, `eleven_${label}_${Date.now()}.png`);
    await page.screenshot({ path: filepath });
    console.log(`[${STEP_NAME}] 📸 ${path.basename(filepath)}`);
  } catch { }
}

/**
 * Wait for any spinners/loading indicators to disappear.
 */
async function waitForSpinnersGone(page, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const spinners = page.locator("[role='progressbar'], [aria-busy='true'], .spinner, [class*='loading']").first();
    const count = await spinners.count();
    if (count === 0) return;
    const visible = await spinners.isVisible().catch(() => false);
    if (!visible) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * Generate audio narration using ElevenLabs Text-to-Speech.
 *
 * ElevenLabs Speech Synthesis UI (as of March 2026):
 *  - Text input: <TEXTAREA> with data-testid="tts-editor", aria-label="Main textarea"
 *  - Voice selector: button with data-testid="tts-voice-selector"
 *  - Generate button: button with text "Generate speech", data-testid="tts-generate"
 *  - After generation: a play button and download button appear in the history
 */
export async function generateAudio(context, narrationText) {
  if (!context || !narrationText || typeof narrationText !== "string") {
    throw new Error("context and narrationText (non-empty string) are required");
  }

  const outputPath = path.resolve(process.cwd(), OUTPUT_PATH);
  const audioDir = path.resolve(process.cwd(), AUDIO_DIR);
  await fs.ensureDir(audioDir);

  return retry(async () => {
    const page = await getOrReusePage(context, "https://elevenlabs.io");

    try {
      // ── Navigate to ElevenLabs TTS ──
      console.log(`[${STEP_NAME}] Navigating to ${ELEVENLABS_URL}...`);
      await page.goto(ELEVENLABS_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await waitForNetworkIdle(page, 15_000);
      await waitForSpinnersGone(page, 15_000);
      await humanDelay(1000, 2000);
      await debugScreenshot(page, "01_loaded");

      // ── Wait for text editor to be ready ──
      console.log(`[${STEP_NAME}] Waiting for text editor...`);
      const editorSelectors = [
        "[data-testid='tts-editor']",
        "textarea[aria-label='Main textarea']",
        "textarea",
        "[contenteditable='true']",
      ];

      let editor = null;
      for (const sel of editorSelectors) {
        try {
          const el = page.locator(sel).first();
          await el.waitFor({ state: "visible", timeout: 15_000 });
          editor = el;
          console.log(`[${STEP_NAME}] Found editor: ${sel}`);
          break;
        } catch { }
      }

      if (!editor) {
        // Maybe we need to log in
        const loginRequired = await inferLoginRequired(page);
        if (loginRequired) {
          throw new Error("LOGIN_REQUIRED: Log into ElevenLabs first. Run: npm run login");
        }
        await debugScreenshot(page, "editor_not_found");
        throw new Error("Could not find text editor.");
      }

      // ── Clear and fill the text editor ──
      await editor.click();
      await humanDelay(200, 400);

      // Select all existing text and replace
      await page.keyboard.press("Meta+A");
      await humanDelay(100, 200);

      await editor.fill(narrationText.trim());
      await humanDelay(500, 1000);
      console.log(`[${STEP_NAME}] ✅ Text entered (${narrationText.length} chars).`);
      await debugScreenshot(page, "02_text_filled");

      // ── Click "Generate speech" button ──
      console.log(`[${STEP_NAME}] Clicking 'Generate speech'...`);
      const generateSelectors = [
        "[data-testid='tts-generate']",
        "button[aria-label*='Generate speech']",
        "button:has-text('Generate speech')",
        "button:has-text('Generate')",
        "button:has-text('Convert')",
      ];

      let generateClicked = false;
      for (const sel of generateSelectors) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 5_000 })) {
            await el.click();
            generateClicked = true;
            console.log(`[${STEP_NAME}] ✅ Generate clicked via: ${sel}`);
            break;
          }
        } catch { }
      }

      if (!generateClicked) {
        await debugScreenshot(page, "generate_not_found");
        throw new Error("Could not find 'Generate speech' button.");
      }

      // ── Wait for generation to complete ──
      console.log(`[${STEP_NAME}] Waiting for audio generation (up to ${GENERATION_TIMEOUT_MS / 1000}s)...`);
      await humanDelay(3000, 5000);

      // Wait for spinner to finish
      await waitForSpinnersGone(page, GENERATION_TIMEOUT_MS);
      await humanDelay(2000, 3000);
      await debugScreenshot(page, "03_after_generation");

      // ── Download the generated audio ──
      // ElevenLabs shows generated audio in a history list.
      // Look for download button, three-dot menu, or direct download link.
      console.log(`[${STEP_NAME}] Looking for download option...`);

      let downloaded = false;

      // Method 1: Direct download button
      const downloadSelectors = [
        "button:has-text('Download')",
        "a:has-text('Download')",
        "[aria-label*='download']",
        "[aria-label*='Download']",
        "button[aria-label*='Download']",
      ];

      for (const sel of downloadSelectors) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 5_000 })) {
            const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
            await el.click();
            const download = await downloadPromise;
            await download.saveAs(outputPath);
            const failure = await download.failure();
            if (failure) throw new Error(`Download failed: ${failure}`);
            downloaded = true;
            break;
          }
        } catch (err) {
          if (err.message?.includes("Download failed")) throw err;
        }
      }

      // Method 2: Click the three-dot menu on the generated item, then "Download"
      if (!downloaded) {
        console.log(`[${STEP_NAME}] Trying three-dot menu...`);
        try {
          // Find the most recent generated history item's menu
          const moreMenuSelectors = [
            "button[aria-label='More options']",
            "button[aria-label='More']",
            "[data-testid='history-item-more']",
          ];

          for (const menuSel of moreMenuSelectors) {
            const menuBtn = page.locator(menuSel).first();
            if (await menuBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
              await menuBtn.click();
              await humanDelay(500, 1000);

              // Now look for "Download" in the dropdown
              const dlOption = page.locator("[role='menuitem']:has-text('Download'), button:has-text('Download MP3'), button:has-text('Download')").first();
              if (await dlOption.isVisible({ timeout: 3_000 }).catch(() => false)) {
                const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
                await dlOption.click();
                const download = await downloadPromise;
                await download.saveAs(outputPath);
                downloaded = true;
              }
              break;
            }
          }
        } catch { }
      }

      // Method 3: Intercept audio from network
      if (!downloaded) {
        console.log(`[${STEP_NAME}] Trying to capture audio from network...`);
        try {
          // Look for audio elements on the page
          const audioSrc = await page.evaluate(() => {
            const audio = document.querySelector("audio");
            return audio?.src || null;
          });

          if (audioSrc) {
            const resp = await page.context().request.get(audioSrc);
            if (resp.ok()) {
              await fs.writeFile(outputPath, await resp.body());
              downloaded = true;
              console.log(`[${STEP_NAME}] ✅ Audio captured from <audio> element.`);
            }
          }
        } catch { }
      }

      if (!downloaded) {
        await debugScreenshot(page, "download_failed");
        throw new Error("Could not download the generated audio.");
      }

      const stat = await fs.stat(outputPath);
      console.log(`[${STEP_NAME}] ✅ Audio saved: ${outputPath} (${stat.size} bytes)`);

    } catch (err) {
      await debugScreenshot(page, "error");
      throw new Error(classifyStepError(STEP_NAME, err));
    }
  }, 3, 3000);
}
