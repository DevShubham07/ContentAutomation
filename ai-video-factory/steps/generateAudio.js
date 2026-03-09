import path from "node:path";
import fs from "fs-extra";
import { retry } from "../utils/retry.js";
import { humanDelay } from "../utils/delay.js";
import { waitForNetworkIdle } from "../utils/networkIdle.js";
import { classifyStepError, inferLoginRequired } from "../utils/stepGuards.js";

const STEP_NAME = "generateAudio";
const ELEVENLABS_URL = "https://elevenlabs.io/app/speech-synthesis";
const AUDIO_DIR = "./assets/audio";
const OUTPUT_PATH = "./assets/audio/narration.mp3";
const LOGIN_WAIT_MS = 300_000;
const GENERATION_TIMEOUT_MS = 120_000;

const SELECTORS = {
  textInput: "textarea, [contenteditable='true'], [data-testid='text-input']",
  generateButton: "button:has-text('Generate'), button:has-text('Convert')",
  downloadButton: "button:has-text('Download'), a:has-text('Download'), [aria-label*='download']",
  spinner: "[role='progressbar'], [aria-busy='true'], .spinner, [class*='loading']",
};

async function waitForSpinnersGone(page, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const spinner = page.locator(SELECTORS.spinner).first();
    const count = await spinner.count();
    if (count === 0) return;
    const visible = await spinner.isVisible().catch(() => false);
    if (!visible) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}

import { getOrReusePage } from "../utils/browser.js";

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
      console.log(`[${STEP_NAME}] Navigating to ${ELEVENLABS_URL}...`);
      await page.goto(ELEVENLABS_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await waitForNetworkIdle(page, 15_000);
      await waitForSpinnersGone(page, 15_000);
      await humanDelay(600, 1300);

      console.log(`[${STEP_NAME}] Waiting for text input (up to ${LOGIN_WAIT_MS / 1000}s)...`);
      const textInput = page.locator(SELECTORS.textInput).first();
      try {
        await textInput.waitFor({ state: "visible", timeout: LOGIN_WAIT_MS });
      } catch (err) {
        const loginRequired = await inferLoginRequired(page);
        if (loginRequired) {
          throw new Error("Login required on ElevenLabs (text input not available)");
        }
        throw err;
      }
      await humanDelay(300, 700);

      await textInput.fill("");
      await textInput.fill(narrationText.trim());
      await waitForSpinnersGone(page, 5_000);
      await humanDelay(400, 900);

      const generateBtn = page.locator(SELECTORS.generateButton).first();
      await generateBtn.waitFor({ state: "visible", timeout: 10_000 });
      await generateBtn.click();

      await waitForSpinnersGone(page, GENERATION_TIMEOUT_MS);

      const downloadBtn = page.locator(SELECTORS.downloadButton).first();
      await downloadBtn.waitFor({ state: "visible", timeout: GENERATION_TIMEOUT_MS });

      const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
      await downloadBtn.click();

      const download = await downloadPromise;
      await download.saveAs(outputPath);

      const failure = await download.failure();
      if (failure) {
        throw new Error(`Download failed: ${failure}`);
      }
    } catch (err) {
      throw new Error(classifyStepError(STEP_NAME, err));
    }
  }, 3, 2000);
}
