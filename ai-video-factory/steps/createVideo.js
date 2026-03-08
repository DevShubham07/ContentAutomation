import path from "node:path";
import fs from "fs-extra";
import { spawn } from "node:child_process";
import { retry } from "../utils/retry.js";
import { humanDelay } from "../utils/delay.js";
import { waitForNetworkIdle } from "../utils/networkIdle.js";
import { classifyStepError, inferLoginRequired } from "../utils/stepGuards.js";

const STEP_NAME = "createVideo";

const FLOW_URL = "https://labs.google/fx/flow";
const FRAMES_DIR = "./assets/frames";
const VIDEO_DIR = "./assets/video";
const OUTPUT_PATH = "./assets/video/output.mp4";
const GENERATION_TIMEOUT_MS = 300_000; // 5 min for video generation

// Google Flow UI selectors (may need adjustment for UI changes)
const SELECTORS = {
  addButton: "button:has-text('Add'), [aria-label*='Add'], [data-testid='add-frames']",
  fileInput: "input[type='file']",
  framesToVideo: "button:has-text('Frames to Video'), [data-value='frames-to-video'], .mode-frames",
  interpolation: "button:has-text('Smooth'), [aria-label*='interpolation'], [aria-label*='Smooth']",
  generateButton: "button:has-text('Generate'), button:has-text('Create')",
  downloadButton: "button:has-text('Download'), a:has-text('Download'), [aria-label*='download']",
};

function getFramePaths(framesDir) {
  const files = fs.readdirSync(framesDir);
  return files
    .filter((f) => f.match(/^frame_\d{4}\.png$/i))
    .sort()
    .map((f) => path.join(framesDir, f));
}

function mergeVideoSegments(segments, outputPath) {
  return new Promise((resolve, reject) => {
    if (segments.length === 0) {
      reject(new Error("No segments to merge"));
      return;
    }
    if (segments.length === 1) {
      fs.copyFileSync(segments[0], outputPath);
      resolve();
      return;
    }

    const listPath = path.join(path.dirname(outputPath), "concat-list.txt");
    const listContent = segments.map((s) => `file '${path.resolve(s)}'`).join("\n");
    fs.writeFileSync(listPath, listContent);

    const proc = spawn('ffmpeg', [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", listPath,
      "-c", "copy",
      outputPath,
    ], { stdio: "pipe" });

    let stderr = "";
    proc.stderr?.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      fs.removeSync(listPath).catch(() => { });
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg failed: ${stderr.slice(-500)}`));
    });
    proc.on("error", reject);
  });
}

import { getOrReusePage } from "../utils/browser.js";

// ... [existing code] ...

export async function createVideo(context) {
  if (!context) {
    throw new Error("context is required");
  }

  const framesDir = path.resolve(process.cwd(), FRAMES_DIR);
  const outputPath = path.resolve(process.cwd(), OUTPUT_PATH);
  const videoDir = path.resolve(process.cwd(), VIDEO_DIR);

  const framePaths = getFramePaths(framesDir);
  if (framePaths.length === 0) {
    throw new Error(`No frame files found in ${FRAMES_DIR}`);
  }

  await fs.ensureDir(videoDir);

  return retry(async () => {
    const page = await getOrReusePage(context, "https://labs.google");

    try {
      console.log(`[${STEP_NAME}] Navigating to ${FLOW_URL}...`);
      await page.goto(FLOW_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await waitForNetworkIdle(page, 15_000);
      await humanDelay(800, 1600);

      console.log(`[${STEP_NAME}] Waiting for Add button...`);
      const addBtn = page.locator(SELECTORS.addButton).first();
      try {
        await addBtn.waitFor({ state: "visible", timeout: 60_000 });
      } catch (err) {
        const loginRequired = await inferLoginRequired(page);
        if (loginRequired) {
          throw new Error("Login required on Google Flow (Add button not available)");
        }
        throw err;
      }

      const fileInput = page.locator(SELECTORS.fileInput).first();
      const hasFileInput = (await fileInput.count()) > 0;

      if (hasFileInput) {
        await fileInput.setInputFiles(framePaths);
      } else {
        const [fileChooser] = await Promise.all([
          page.waitForEvent("filechooser", { timeout: 10_000 }),
          addBtn.click(),
        ]);
        await fileChooser.setFiles(framePaths);
      }
      await humanDelay(500, 1200);

      const framesToVideo = page.locator(SELECTORS.framesToVideo).first();
      if ((await framesToVideo.count()) > 0) {
        await framesToVideo.click();
      }

      const interpolation = page.locator(SELECTORS.interpolation).first();
      if ((await interpolation.count()) > 0) {
        await interpolation.click();
        await humanDelay(200, 500);
      }

      const generateBtn = page.locator(SELECTORS.generateButton).first();
      await generateBtn.waitFor({ state: "visible", timeout: 5_000 });
      await generateBtn.click();

      console.log(`[${STEP_NAME}] Waiting for video generation (up to ${GENERATION_TIMEOUT_MS / 1000}s)...`);
      const downloadBtn = page.locator(SELECTORS.downloadButton).first();
      await downloadBtn.waitFor({ state: "visible", timeout: GENERATION_TIMEOUT_MS });

      const segmentPaths = [];
      const SEGMENT_COALESCE_MS = 3000;

      const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
      await downloadBtn.click();

      let download = await downloadPromise;
      let idx = 0;
      while (download) {
        const segPath = path.join(videoDir, `segment_${idx}.mp4`);
        await download.saveAs(segPath);
        const failure = await download.failure();
        if (failure) {
          throw new Error(`Download failed: ${failure}`);
        }
        segmentPaths.push(segPath);
        idx++;

        try {
          download = await page.waitForEvent("download", { timeout: SEGMENT_COALESCE_MS });
        } catch {
          download = null;
        }
      }

      await mergeVideoSegments(segmentPaths, outputPath);

      for (const seg of segmentPaths) {
        fs.remove(seg).catch(() => { });
      }
    } catch (err) {
      throw new Error(classifyStepError(STEP_NAME, err));
    } finally {
      await page.close();
    }
  }, 3, 2000);
}
