import path from "node:path";
import fs from "fs-extra";
import { spawn } from "node:child_process";
import { retry } from "../utils/retry.js";
import { humanDelay } from "../utils/delay.js";
import { waitForNetworkIdle } from "../utils/networkIdle.js";
import { classifyStepError, inferLoginRequired } from "../utils/stepGuards.js";
import { getOrReusePage } from "../utils/browser.js";

const STEP_NAME = "createVideo";

const FLOW_URL = "https://labs.google/fx/flow";
const FRAMES_DIR = "./assets/frames";
const VIDEO_DIR = "./assets/video";
const OUTPUT_PATH = "./assets/video/output.mp4";
const GENERATION_TIMEOUT_MS = 300_000; // 5 min for video generation

function getFramePaths(framesDir) {
  const files = fs.readdirSync(framesDir);
  return files
    .filter((f) => f.match(/^frame_\d{4}\.png$/i))
    .sort()
    .map((f) => path.join(framesDir, f));
}

/**
 * Helper: click the first visible element matching any of the given selectors.
 * Returns true if clicked, false otherwise.
 */
async function clickFirst(page, selectors, timeoutMs = 5000) {
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    try {
      if (await el.isVisible({ timeout: timeoutMs })) {
        await el.click();
        return true;
      }
    } catch { }
  }
  return false;
}

/**
 * Helper: wait until any of the given selectors becomes visible.
 * Returns the locator that became visible, or throws on timeout.
 */
async function waitForAny(page, selectors, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const sel of selectors) {
      const el = page.locator(sel).first();
      try {
        const visible = await el.isVisible();
        if (visible) return el;
      } catch { }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`None of the selectors became visible within ${timeoutMs / 1000}s: ${selectors.join(", ")}`);
}

/**
 * Create video using Google Flow — Frames to Video workflow.
 *
 * Workflow:
 * 1. Navigate to Flow
 * 2. Create a new project (or reuse existing)
 * 3. Select "Frames to Video" mode
 * 4. Set portrait (9:16) aspect ratio
 * 5. Upload the 2 frame images as start and end frame
 * 6. Enter the video prompt
 * 7. Click Generate
 * 8. Wait for generation and download
 */
export async function createVideo(context, videoPrompt = "") {
  if (!context) {
    throw new Error("context is required");
  }

  const framesDir = path.resolve(process.cwd(), FRAMES_DIR);
  const outputPath = path.resolve(process.cwd(), OUTPUT_PATH);
  const videoDir = path.resolve(process.cwd(), VIDEO_DIR);

  const framePaths = getFramePaths(framesDir);
  if (framePaths.length < 2) {
    throw new Error(`Need at least 2 frames in ${FRAMES_DIR}, found ${framePaths.length}`);
  }

  // Use first and last frame as start/end
  const startFrame = framePaths[0];
  const endFrame = framePaths[framePaths.length - 1];

  await fs.ensureDir(videoDir);

  return retry(async () => {
    const page = await getOrReusePage(context, "https://labs.google");

    try {
      // ── Step 1: Navigate to Flow ──
      console.log(`[${STEP_NAME}] Navigating to ${FLOW_URL}...`);
      await page.goto(FLOW_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await waitForNetworkIdle(page, 15_000);
      await humanDelay(2000, 3000);

      // Check if login is required
      const loginRequired = await inferLoginRequired(page);
      if (loginRequired) {
        throw new Error("LOGIN_REQUIRED: Log into Google Flow first. Run: npm run login");
      }

      // ── Step 2: Create a new project ──
      console.log(`[${STEP_NAME}] Looking for 'New project' or create button...`);
      const newProjectClicked = await clickFirst(page, [
        "button:has-text('New project')",
        "button:has-text('New')",
        "button:has-text('Create')",
        "button:has-text('Create new')",
        "[aria-label*='New project']",
        "[aria-label*='Create']",
        "button:has-text('+')",
      ], 10_000);

      if (newProjectClicked) {
        console.log(`[${STEP_NAME}] Created new project.`);
        await humanDelay(2000, 3000);
        await waitForNetworkIdle(page, 10_000);
      } else {
        console.log(`[${STEP_NAME}] No 'New project' button found — may already be in a project.`);
      }

      // ── Step 3: Select "Frames to Video" mode ──
      console.log(`[${STEP_NAME}] Selecting 'Frames to Video' mode...`);
      // Look for mode selector / dropdown
      const modeClicked = await clickFirst(page, [
        "button:has-text('Frames to Video')",
        "[aria-label*='Frames to Video']",
        "button:has-text('Frames to video')",
        "[data-value='frames-to-video']",
      ], 8_000);

      if (!modeClicked) {
        // Try clicking a mode dropdown first, then selecting
        console.log(`[${STEP_NAME}] Looking for mode dropdown...`);
        const dropdownClicked = await clickFirst(page, [
          "button:has-text('Text to Video')",
          "button:has-text('Text to video')",
          "[aria-label*='mode']",
          "[aria-label*='Mode']",
          ".mode-selector",
          "[role='listbox']",
          "[role='combobox']",
        ], 5_000);

        if (dropdownClicked) {
          await humanDelay(500, 1000);
          await clickFirst(page, [
            "button:has-text('Frames to Video')",
            "[aria-label*='Frames to Video']",
            "li:has-text('Frames to Video')",
            "[role='option']:has-text('Frames to Video')",
            "div:has-text('Frames to Video')",
          ], 5_000);
        }
      }
      await humanDelay(1000, 2000);
      console.log(`[${STEP_NAME}] Mode set.`);

      // ── Step 4: Select portrait (9:16) aspect ratio ──
      console.log(`[${STEP_NAME}] Setting portrait 9:16 aspect ratio...`);
      const portraitClicked = await clickFirst(page, [
        "button:has-text('9:16')",
        "button:has-text('Portrait')",
        "[aria-label*='9:16']",
        "[aria-label*='portrait']",
        "[aria-label*='Portrait']",
        "[data-value='9:16']",
      ], 5_000);

      if (!portraitClicked) {
        // Try clicking an aspect ratio selector first
        const arClicked = await clickFirst(page, [
          "button:has-text('16:9')",
          "button:has-text('1:1')",
          "[aria-label*='aspect']",
          "[aria-label*='Aspect']",
          "[aria-label*='ratio']",
        ], 5_000);
        if (arClicked) {
          await humanDelay(500, 1000);
          await clickFirst(page, [
            "button:has-text('9:16')",
            "button:has-text('Portrait')",
            "[aria-label*='9:16']",
            "[role='option']:has-text('9:16')",
            "li:has-text('9:16')",
          ], 5_000);
        }
      }
      await humanDelay(500, 1000);
      console.log(`[${STEP_NAME}] Aspect ratio set.`);

      // ── Step 5: Upload frames as start and end frame ──
      console.log(`[${STEP_NAME}] Uploading start frame: ${path.basename(startFrame)}`);
      console.log(`[${STEP_NAME}] Uploading end frame: ${path.basename(endFrame)}`);

      // Look for file input or drag areas
      const fileInputs = page.locator("input[type='file']");
      const fileInputCount = await fileInputs.count();

      if (fileInputCount >= 2) {
        // Two separate file inputs for start and end frame
        await fileInputs.nth(0).setInputFiles(startFrame);
        await humanDelay(1000, 2000);
        await fileInputs.nth(1).setInputFiles(endFrame);
      } else if (fileInputCount === 1) {
        // Single file input — upload both
        await fileInputs.first().setInputFiles([startFrame, endFrame]);
      } else {
        // Try clicking upload/add buttons to get file chooser
        console.log(`[${STEP_NAME}] No file input found, looking for upload buttons...`);

        // Upload start frame
        const startUploadSelectors = [
          "button:has-text('Start frame')",
          "button:has-text('First frame')",
          "[aria-label*='start frame']",
          "[aria-label*='Start frame']",
          "button:has-text('Add start')",
          "button:has-text('Upload')",
          "[aria-label*='Upload']",
          "button:has-text('Add')",
        ];
        const [fileChooser1] = await Promise.all([
          page.waitForEvent("filechooser", { timeout: 15_000 }),
          clickFirst(page, startUploadSelectors, 10_000),
        ]);
        await fileChooser1.setFiles(startFrame);
        await humanDelay(1500, 2500);

        // Upload end frame
        const endUploadSelectors = [
          "button:has-text('End frame')",
          "button:has-text('Last frame')",
          "[aria-label*='end frame']",
          "[aria-label*='End frame']",
          "button:has-text('Add end')",
          "button:has-text('Upload')",
          "button:has-text('Add')",
        ];
        const [fileChooser2] = await Promise.all([
          page.waitForEvent("filechooser", { timeout: 15_000 }),
          clickFirst(page, endUploadSelectors, 10_000),
        ]);
        await fileChooser2.setFiles(endFrame);
      }

      await humanDelay(2000, 3000);
      console.log(`[${STEP_NAME}] Frames uploaded.`);

      // ── Step 6: Enter video prompt ──
      if (videoPrompt) {
        console.log(`[${STEP_NAME}] Entering video prompt: ${videoPrompt.slice(0, 80)}...`);
        const promptInputSelectors = [
          "textarea",
          "[contenteditable='true']",
          "input[type='text']",
          "[aria-label*='prompt']",
          "[aria-label*='Prompt']",
          "[placeholder*='Describe']",
          "[placeholder*='prompt']",
        ];

        let promptEl = null;
        for (const sel of promptInputSelectors) {
          const el = page.locator(sel).first();
          try {
            if (await el.isVisible({ timeout: 3000 })) {
              promptEl = el;
              break;
            }
          } catch { }
        }

        if (promptEl) {
          await promptEl.focus();
          await promptEl.fill(videoPrompt);
          await humanDelay(500, 1000);
          console.log(`[${STEP_NAME}] Prompt entered.`);
        } else {
          console.warn(`[${STEP_NAME}] Could not find prompt input, proceeding without prompt.`);
        }
      }

      // ── Step 7: Click Generate ──
      console.log(`[${STEP_NAME}] Clicking Generate...`);
      const generateClicked = await clickFirst(page, [
        "button:has-text('Generate')",
        "button:has-text('Create')",
        "button:has-text('Start')",
        "[aria-label*='Generate']",
        "[aria-label*='Create']",
      ], 10_000);

      if (!generateClicked) {
        // Try pressing Enter as fallback
        await page.keyboard.press("Enter");
      }

      // ── Step 8: Wait for generation and download ──
      console.log(`[${STEP_NAME}] Waiting for video generation (up to ${GENERATION_TIMEOUT_MS / 1000}s)...`);
      await humanDelay(5000, 8000);

      // Wait for download button to appear (indicates generation is complete)
      const downloadBtnSelectors = [
        "button:has-text('Download')",
        "a:has-text('Download')",
        "[aria-label*='download']",
        "[aria-label*='Download']",
        "button:has-text('Export')",
      ];

      const downloadBtn = await waitForAny(page, downloadBtnSelectors, GENERATION_TIMEOUT_MS);
      console.log(`[${STEP_NAME}] Video generated! Downloading...`);

      // Click download and capture the download event
      const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
      await downloadBtn.click();

      const download = await downloadPromise;
      await download.saveAs(outputPath);

      const failure = await download.failure();
      if (failure) {
        throw new Error(`Download failed: ${failure}`);
      }

      const stat = await fs.stat(outputPath);
      console.log(`[${STEP_NAME}] ✅ Video saved: ${outputPath} (${stat.size} bytes)`);

    } catch (err) {
      throw new Error(classifyStepError(STEP_NAME, err));
    }
  }, 3, 5000);
}
