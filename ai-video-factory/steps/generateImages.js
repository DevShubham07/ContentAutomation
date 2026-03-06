import path from "node:path";
import fs from "fs-extra";
import { retry } from "../utils/retry.js";
import { humanDelay } from "../utils/delay.js";
import { waitForNetworkIdle } from "../utils/networkIdle.js";
import { classifyStepError, inferLoginRequired } from "../utils/stepGuards.js";

const STEP_NAME = "generateImages";
const GROK_IMAGINE_URL = "https://grok.com";
const FRAMES_DIR = "./assets/frames";
const BATCH_SIZE = 10;
const IMAGE_READY_TIMEOUT_MS = 60_000;

const SELECTORS = {
  promptInput: "textarea, [contenteditable='true'], input[type='text']",
  generateButton: "button:has-text('Generate'), button:has-text('Create'), button:has-text('Imagine')",
  generatedImage: "img[src*='blob'], img[src*='data'], [data-testid='generated-image'] img, .generated-image img",
  downloadButton: "button:has-text('Download'), a:has-text('Download'), [aria-label*='download']",
};

function formatFrameIndex(index) {
  return String(index).padStart(4, "0");
}

export async function generateImages(context, frames) {
  if (!context || !Array.isArray(frames) || frames.length === 0) {
    throw new Error("context and non-empty frames array are required");
  }

  const framesDir = path.resolve(process.cwd(), FRAMES_DIR);
  await fs.ensureDir(framesDir);

  for (let batchStart = 0; batchStart < frames.length; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, frames.length);
    const batch = frames.slice(batchStart, batchEnd);

    const page = await context.newPage();

    try {
      console.log(`[${STEP_NAME}] Batch ${batchStart + 1}-${batchEnd}: Navigating to ${GROK_IMAGINE_URL}...`);
      await page.goto(GROK_IMAGINE_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await waitForNetworkIdle(page, 15_000);
      await humanDelay(600, 1400);

      for (let i = 0; i < batch.length; i++) {
        const frameIndex = batchStart + i;
        const prompt = batch[i];
        const filename = `frame_${formatFrameIndex(frameIndex)}.png`;
        const destPath = path.join(framesDir, filename);

        await retry(async () => {
          try {
            console.log(`[${STEP_NAME}] Generating frame ${frameIndex + 1}/${frames.length}...`);
            const promptInput = page.locator(SELECTORS.promptInput).first();
            try {
              await promptInput.waitFor({ state: "visible", timeout: 10_000 });
            } catch (err) {
              const loginRequired = await inferLoginRequired(page);
              if (loginRequired) {
                throw new Error("Login required on Grok (prompt input not available)");
              }
              throw err;
            }
            await humanDelay(200, 500);
            await promptInput.fill("");
            await promptInput.fill(prompt);
            await humanDelay(300, 600);

            const generateBtn = page.locator(SELECTORS.generateButton).first();
            await generateBtn.waitFor({ state: "visible", timeout: 5_000 });
            await generateBtn.click();

            await page.locator(SELECTORS.generatedImage).first().waitFor({ state: "visible", timeout: IMAGE_READY_TIMEOUT_MS });

            const downloadPromise = page.waitForEvent("download", { timeout: 15_000 });
            const downloadBtn = page.locator(SELECTORS.downloadButton).first();
            await downloadBtn.waitFor({ state: "visible", timeout: 5_000 });
            await downloadBtn.click();

            const download = await downloadPromise;
            await download.saveAs(destPath);

            const failure = await download.failure();
            if (failure) {
              throw new Error(`Download failed: ${failure}`);
            }
          } catch (err) {
            const msg = classifyStepError(STEP_NAME, err);
            throw new Error(`${msg} (frame ${frameIndex + 1})`);
          }
        }, 3, 2000);

        if (i < batch.length - 1) {
          await humanDelay(500, 2000);
        }
      }
    } finally {
      await page.close();
    }
  }
}
