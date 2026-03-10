import path from "node:path";
import fs from "fs-extra";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { retry } from "../utils/retry.js";
import { humanDelay } from "../utils/delay.js";
import { waitForNetworkIdle } from "../utils/networkIdle.js";
import { classifyStepError, inferLoginRequired } from "../utils/stepGuards.js";
import { getOrReusePage } from "../utils/browser.js";

const execAsync = promisify(exec);
const STEP_NAME = "createVideo";

const FLOW_URL = "https://labs.google/fx/flow";
const FRAMES_DIR = "./assets/frames";
const VIDEO_DIR = "./assets/video";
const OUTPUT_PATH = "./assets/video/output.mp4";
const GENERATION_TIMEOUT_MS = 300_000; // 5 min per video segment
const SCREENSHOTS_DIR = "./assets/debug-screenshots";

function getFramePaths(framesDir) {
  const files = fs.readdirSync(framesDir);
  return files
    .filter((f) => f.match(/^frame_\d{4}\.png$/i))
    .sort()
    .map((f) => path.join(framesDir, f));
}

/**
 * Take a debug screenshot (for troubleshooting).
 */
async function debugScreenshot(page, label) {
  try {
    const dir = path.resolve(process.cwd(), SCREENSHOTS_DIR);
    await fs.ensureDir(dir);
    const filepath = path.join(dir, `flow_${label}_${Date.now()}.png`);
    await page.screenshot({ path: filepath });
    console.log(`[${STEP_NAME}] 📸 ${path.basename(filepath)}`);
  } catch { }
}

/**
 * Generate a single video segment in Google Flow.
 *
 * @param {Page} page    - Playwright page already on Google Flow
 * @param {string} startFrame - Absolute path to start frame image
 * @param {string} endFrame   - Absolute path to end frame image
 * @param {string} prompt     - Video transition prompt
 * @param {string} segmentPath - Where to save the downloaded segment
 * @param {number} segIdx     - Segment index (for logging)
 */
async function generateOneSegment(page, startFrame, endFrame, prompt, segmentPath, segIdx) {
  const label = `seg${segIdx}`;

  // ── Navigate to Flow landing ──
  console.log(`[${STEP_NAME}] [Seg ${segIdx}] Navigating to Flow...`);
  await page.goto(FLOW_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await waitForNetworkIdle(page, 15_000);
  await humanDelay(3000, 4000);

  // Dismiss banner
  try {
    const closeBtn = page.locator("button:has-text('close')").first();
    if (await closeBtn.isVisible({ timeout: 2000 })) {
      await closeBtn.click();
      await humanDelay(500, 1000);
    }
  } catch { }

  // ── Create new project ──
  console.log(`[${STEP_NAME}] [Seg ${segIdx}] Creating new project...`);
  const newProjBtn = page.locator("button:has-text('New project')").first();
  await newProjBtn.waitFor({ state: "visible", timeout: 15_000 });
  await newProjBtn.click();
  await waitForNetworkIdle(page, 10_000);
  await humanDelay(3000, 5000);
  await debugScreenshot(page, `${label}_01_project`);

  // ── Upload START frame ──
  console.log(`[${STEP_NAME}] [Seg ${segIdx}] Uploading start frame: ${path.basename(startFrame)}`);
  const startSelectors = [
    "button:has-text('Start')",
    "text=Start",
  ];
  let startUploaded = false;
  for (const sel of startSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 3000 })) {
        const [fileChooser] = await Promise.all([
          page.waitForEvent("filechooser", { timeout: 10_000 }),
          el.click(),
        ]);
        await fileChooser.setFiles(startFrame);
        startUploaded = true;
        break;
      }
    } catch { }
  }
  if (!startUploaded) {
    // Fallback: file input
    const fi = page.locator("input[type='file']").first();
    if (await fi.count() > 0) {
      await fi.setInputFiles(startFrame);
      startUploaded = true;
    }
  }
  if (!startUploaded) {
    await debugScreenshot(page, `${label}_start_fail`);
    throw new Error(`[Seg ${segIdx}] Could not upload start frame.`);
  }
  console.log(`[${STEP_NAME}] [Seg ${segIdx}] ✅ Start frame uploaded.`);
  await humanDelay(2000, 3000);
  await debugScreenshot(page, `${label}_02_start_done`);

  // ── Upload END frame ──
  console.log(`[${STEP_NAME}] [Seg ${segIdx}] Uploading end frame: ${path.basename(endFrame)}`);
  const endSelectors = [
    "button:has-text('End')",
    "text=End",
  ];
  let endUploaded = false;
  for (const sel of endSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 3000 })) {
        const [fileChooser] = await Promise.all([
          page.waitForEvent("filechooser", { timeout: 10_000 }),
          el.click(),
        ]);
        await fileChooser.setFiles(endFrame);
        endUploaded = true;
        break;
      }
    } catch { }
  }
  if (!endUploaded) {
    const fis = page.locator("input[type='file']");
    const fiCount = await fis.count();
    if (fiCount >= 2) {
      await fis.nth(1).setInputFiles(endFrame);
      endUploaded = true;
    } else if (fiCount === 1) {
      await fis.first().setInputFiles(endFrame);
      endUploaded = true;
    }
  }
  if (!endUploaded) {
    await debugScreenshot(page, `${label}_end_fail`);
    throw new Error(`[Seg ${segIdx}] Could not upload end frame.`);
  }
  console.log(`[${STEP_NAME}] [Seg ${segIdx}] ✅ End frame uploaded.`);
  await humanDelay(2000, 3000);
  await debugScreenshot(page, `${label}_03_end_done`);

  // ── Enter prompt ──
  if (prompt) {
    console.log(`[${STEP_NAME}] [Seg ${segIdx}] Prompt: ${prompt.slice(0, 80)}...`);
    const promptSelectors = [
      "input[aria-label='Editable text']",
      "input[type='text']",
      "textarea",
      "[contenteditable='true']",
    ];
    for (const sel of promptSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 3000 })) {
          await el.click();
          await el.fill(prompt);
          console.log(`[${STEP_NAME}] [Seg ${segIdx}] ✅ Prompt entered.`);
          break;
        }
      } catch { }
    }
  }
  await humanDelay(500, 1000);

  // ── Click Create ──
  console.log(`[${STEP_NAME}] [Seg ${segIdx}] Clicking Create...`);
  const createSelectors = [
    "button:has-text('Create')",
    "button:has-text('arrow_forward')",
  ];
  let created = false;
  for (const sel of createSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 5000 })) {
        await el.click();
        created = true;
        break;
      }
    } catch { }
  }
  if (!created) {
    await debugScreenshot(page, `${label}_create_fail`);
    throw new Error(`[Seg ${segIdx}] Could not click Create.`);
  }
  console.log(`[${STEP_NAME}] [Seg ${segIdx}] ✅ Create clicked. Waiting for generation...`);
  await humanDelay(5000, 8000);
  await debugScreenshot(page, `${label}_04_generating`);

  // ── Wait for video to be ready ──
  const start = Date.now();
  const POLL_MS = 5_000;
  let ready = false;

  while (Date.now() - start < GENERATION_TIMEOUT_MS) {
    // Check for download button
    for (const sel of ["button:has-text('Download')", "a:has-text('Download')", "[aria-label*='Download']", "button:has-text('download')"]) {
      try {
        if (await page.locator(sel).first().isVisible({ timeout: 1000 })) { ready = true; break; }
      } catch { }
    }
    if (ready) break;

    // Check for video element
    if (await page.locator("video").count() > 0) { ready = true; break; }

    const elapsed = Math.round((Date.now() - start) / 1000);
    if (elapsed % 15 === 0 && elapsed > 0) {
      console.log(`[${STEP_NAME}] [Seg ${segIdx}]   Still generating... (${elapsed}s)`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  await debugScreenshot(page, `${label}_05_done`);

  if (!ready) {
    throw new Error(`[Seg ${segIdx}] Video generation timed out.`);
  }

  // ── Download ──
  console.log(`[${STEP_NAME}] [Seg ${segIdx}] Downloading video...`);
  let downloaded = false;

  for (const sel of ["button:has-text('Download')", "a:has-text('Download')", "[aria-label*='Download']"]) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 3000 })) {
        const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
        await el.click();
        const download = await downloadPromise;
        await download.saveAs(segmentPath);
        const failure = await download.failure();
        if (failure) throw new Error(`Download failed: ${failure}`);
        downloaded = true;
        break;
      }
    } catch (err) {
      if (err.message.includes("Download failed")) throw err;
    }
  }

  if (!downloaded) {
    // Fallback: grab video src
    const videoSrc = await page.evaluate(() => {
      const v = document.querySelector("video");
      return v?.src || v?.querySelector("source")?.src || null;
    });
    if (videoSrc) {
      const resp = await page.context().request.get(videoSrc);
      if (resp.ok()) {
        await fs.writeFile(segmentPath, await resp.body());
        downloaded = true;
      }
    }
  }

  if (!downloaded) {
    await debugScreenshot(page, `${label}_download_fail`);
    throw new Error(`[Seg ${segIdx}] Could not download video.`);
  }

  const stat = await fs.stat(segmentPath);
  console.log(`[${STEP_NAME}] [Seg ${segIdx}] ✅ Saved ${path.basename(segmentPath)} (${stat.size} bytes)`);
}

/**
 * Stitch video segments together using ffmpeg.
 */
async function stitchSegments(segmentPaths, outputPath) {
  if (segmentPaths.length === 1) {
    await fs.copy(segmentPaths[0], outputPath);
    return;
  }

  const listPath = path.join(path.dirname(outputPath), "concat-list.txt");
  const listContent = segmentPaths.map((s) => `file '${path.resolve(s)}'`).join("\n");
  await fs.writeFile(listPath, listContent);

  const cmd = `ffmpeg -y -f concat -safe 0 -i "${listPath}" -c copy "${outputPath}"`;
  console.log(`[${STEP_NAME}] Stitching ${segmentPaths.length} segments...`);

  try {
    await execAsync(cmd, { timeout: 60_000 });
  } catch (err) {
    const msg = err.stderr ? err.stderr.slice(-500) : err.message;
    throw new Error(`[${STEP_NAME}] ffmpeg stitch failed: ${msg}`);
  } finally {
    await fs.remove(listPath).catch(() => { });
  }
}

/**
 * Create video using Google Flow — multi-segment pipeline.
 *
 * @param {BrowserContext} context      - Playwright browser context
 * @param {string[]}      videoPrompts - Array of transition prompts (one per frame pair)
 */
export async function createVideo(context, videoPrompts = []) {
  if (!context) throw new Error("context is required");

  const framesDir = path.resolve(process.cwd(), FRAMES_DIR);
  const outputPath = path.resolve(process.cwd(), OUTPUT_PATH);
  const videoDir = path.resolve(process.cwd(), VIDEO_DIR);
  await fs.ensureDir(videoDir);

  const framePaths = getFramePaths(framesDir);
  if (framePaths.length < 2) {
    throw new Error(`Need at least 2 frames, found ${framePaths.length}`);
  }

  // Number of segments = number of consecutive frame pairs
  const segmentCount = framePaths.length - 1;
  console.log(`[${STEP_NAME}] Will generate ${segmentCount} video segment(s) from ${framePaths.length} frames.`);

  // Ensure we have enough prompts (pad with defaults if needed)
  const prompts = [];
  for (let i = 0; i < segmentCount; i++) {
    prompts.push(videoPrompts[i] || "Smooth cinematic transition between the two frames");
  }

  const page = await getOrReusePage(context, "https://labs.google");

  // Check login
  await page.goto(FLOW_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await waitForNetworkIdle(page, 10_000);
  await humanDelay(2000, 3000);
  const loginRequired = await inferLoginRequired(page);
  if (loginRequired) {
    throw new Error("LOGIN_REQUIRED: Log into Google Flow first. Run: npm run login");
  }

  const segmentPaths = [];

  for (let i = 0; i < segmentCount; i++) {
    const segPath = path.join(videoDir, `segment_${i}.mp4`);

    // Retry each segment individually
    await retry(async () => {
      try {
        await generateOneSegment(
          page,
          framePaths[i],
          framePaths[i + 1],
          prompts[i],
          segPath,
          i
        );
      } catch (err) {
        throw new Error(classifyStepError(STEP_NAME, err));
      }
    }, 2, 5000);

    segmentPaths.push(segPath);

    if (i < segmentCount - 1) {
      console.log(`[${STEP_NAME}] Pausing before next segment...`);
      await humanDelay(3000, 5000);
    }
  }

  // ── Stitch all segments into output.mp4 ──
  await stitchSegments(segmentPaths, outputPath);

  // Clean up individual segments
  for (const seg of segmentPaths) {
    await fs.remove(seg).catch(() => { });
  }

  const stat = await fs.stat(outputPath);
  console.log(`[${STEP_NAME}] ✅ Final video: ${outputPath} (${stat.size} bytes)`);
}
