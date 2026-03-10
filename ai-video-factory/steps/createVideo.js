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

  // ── Ensure VIDEO mode is selected (click '+' or Video pill) ──
  // The Start/End div buttons only appear when Video mode is active.
  try {
    // Click the '+' button to expand the media type picker
    const plusBtn = page.locator("button[aria-label='+'], button:has-text('+')").first();
    if (await plusBtn.isVisible({ timeout: 3000 })) {
      await plusBtn.click();
      await humanDelay(1000, 1500);
      // Click the 'Video' option
      const videoOption = page.locator("text='Video', [data-value='video'], button:has-text('Video')").first();
      if (await videoOption.isVisible({ timeout: 3000 })) {
        await videoOption.click();
        await humanDelay(1000, 1500);
      }
    }
  } catch { }
  await debugScreenshot(page, `${label}_01b_videomode`);

  // ── Helper: open asset picker and upload a file ──
  async function uploadViaAssetPicker(triggerLocator, filePath, frameLabel) {
    const filename = path.basename(filePath);
    let uploaded = false;

    // First try: native file chooser (older Flow UI)
    try {
      const [fc] = await Promise.all([
        page.waitForEvent("filechooser", { timeout: 4000 }),
        triggerLocator.click(),
      ]);
      await fc.setFiles(filePath);
      console.log(`[${STEP_NAME}] [Seg ${segIdx}] ✅ ${frameLabel} uploaded via file chooser.`);
      uploaded = true;
    } catch {
      // Asset picker opened instead
    }

    if (!uploaded) {
      // Asset picker: wait for it to appear
      await humanDelay(800, 1200);

      // Check if the file is already in the picker (previously uploaded)
      const existingItem = page.locator(`text="${filename}"`).first();
      try {
        if (await existingItem.isVisible({ timeout: 3000 })) {
          await existingItem.click();
          console.log(`[${STEP_NAME}] [Seg ${segIdx}] ✅ ${frameLabel} selected from asset picker ('${filename}').`);
          uploaded = true;
        }
      } catch { }

      if (!uploaded) {
        // Upload button inside the picker (the upward arrow icon next to search)
        const uploadIcons = [
          "button[aria-label='Upload']",
          "button[aria-label='upload']",
          "[aria-label='Upload'] button",
          "button.upload-button",
          // The upload icon is a mat-icon-button with an upload icon in the search bar area
          "div[class*='search'] button",
          "input[type='file']",
        ];

        for (const sel of uploadIcons) {
          try {
            const el = page.locator(sel).first();
            if (await el.isVisible({ timeout: 2000 })) {
              if (sel === "input[type='file']") {
                await el.setInputFiles(filePath);
                uploaded = true;
              } else {
                const [fc] = await Promise.all([
                  page.waitForEvent("filechooser", { timeout: 8000 }),
                  el.click(),
                ]);
                await fc.setFiles(filePath);
                uploaded = true;
              }
              if (uploaded) {
                console.log(`[${STEP_NAME}] [Seg ${segIdx}] ✅ ${frameLabel} uploaded via picker upload btn (${sel}).`);
                break;
              }
            }
          } catch { }
        }
      }

      // Close/dismiss picker if upload was done
      if (uploaded) {
        await humanDelay(800, 1200);
        // Press Escape only if picker is still visible
        try { await page.keyboard.press("Escape"); } catch { }
      }
    }

    return uploaded;
  }

  // ── Helper to wait for the upload percentage indicator to disappear ──
  async function waitForUploadToFinish(label) {
    console.log(`[${STEP_NAME}] [Seg ${segIdx}] Waiting for ${label} upload to finish...`);
    const startWait = Date.now();
    let isUploading = true;
    while (Date.now() - startWait < 45000) {
      // Check for any text matching 1% to 99% inside the media placeholders
      const percentLoc = page.locator("text=/%/");
      if (await percentLoc.count() === 0) {
        isUploading = false;
        break;
      }
      await humanDelay(1000, 2000);
      await debugScreenshot(page, `${label}_upload_wait_${Math.round((Date.now() - startWait) / 1000)}s`);
    }
    if (isUploading) {
      console.log(`[${STEP_NAME}] [Seg ${segIdx}] Warning: Upload percentage didn't clear after 45s.`);
    } else {
      console.log(`[${STEP_NAME}] [Seg ${segIdx}] ✅ ${label} upload complete.`);
    }
  }

  // ── Upload START frame ──
  console.log(`[${STEP_NAME}] [Seg ${segIdx}] Uploading start frame: ${path.basename(startFrame)}`);
  const startLocators = [
    page.locator("div:has-text('Start') >> nth=0"),
    page.locator("[aria-label='Start frame']").first(),
    page.locator("text=Start").first(),
    page.locator("button:has-text('Start')").first(),
  ];

  let startUploaded = false;
  for (const loc of startLocators) {
    try {
      if (await loc.isVisible({ timeout: 3000 })) {
        startUploaded = await uploadViaAssetPicker(loc, startFrame, "Start frame");
        if (startUploaded) break;
      }
    } catch { }
  }

  if (!startUploaded) {
    const fi = page.locator("input[type='file']").first();
    if (await fi.count() > 0) { await fi.setInputFiles(startFrame); startUploaded = true; }
  }
  if (!startUploaded) {
    await debugScreenshot(page, `${label}_start_fail`);
    throw new Error(`[Seg ${segIdx}] Could not upload start frame.`);
  }
  await waitForUploadToFinish("start_frame");
  await debugScreenshot(page, `${label}_02_start_done`);

  // ── Upload END frame ──
  console.log(`[${STEP_NAME}] [Seg ${segIdx}] Uploading end frame: ${path.basename(endFrame)}`);
  const endLocators = [
    page.locator("div:has-text('End') >> nth=0"),
    page.locator("[aria-label='End frame']").first(),
    page.locator("text=End").first(),
    page.locator("button:has-text('End')").first(),
  ];

  let endUploaded = false;
  for (const loc of endLocators) {
    try {
      if (await loc.isVisible({ timeout: 3000 })) {
        endUploaded = await uploadViaAssetPicker(loc, endFrame, "End frame");
        if (endUploaded) break;
      }
    } catch { }
  }

  if (!endUploaded) {
    const fis = page.locator("input[type='file']");
    const fiCount = await fis.count();
    if (fiCount >= 2) { await fis.nth(1).setInputFiles(endFrame); endUploaded = true; }
    else if (fiCount === 1) { await fis.first().setInputFiles(endFrame); endUploaded = true; }
  }
  if (!endUploaded) {
    await debugScreenshot(page, `${label}_end_fail`);
    throw new Error(`[Seg ${segIdx}] Could not upload end frame.`);
  }
  await waitForUploadToFinish("end_frame");
  await debugScreenshot(page, `${label}_03_end_done`);


  // ── Enter prompt ──
  if (prompt) {
    console.log(`[${STEP_NAME}] [Seg ${segIdx}] Prompt: ${prompt.slice(0, 80)}...`);
    const promptSelectors = [
      "textarea[aria-label*='prompt']",
      "textarea[placeholder*='create']",
      "textarea",
      "[contenteditable='true']",
      "input[type='text']",
    ];
    let promptEntered = false;

    // Retry entering the prompt a few times if it doesn't stick
    for (let attempt = 1; attempt <= 3; attempt++) {
      for (const sel of promptSelectors) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 2000 })) {
            await el.click();
            await humanDelay(300, 500);
            await el.fill(prompt);
            await humanDelay(800, 1200);

            // Verify the text is actually there
            let val = "";
            try { val = await el.inputValue(); } catch { val = await el.textContent(); }
            if (val && val.length > 5) {
              promptEntered = true;
              console.log(`[${STEP_NAME}] [Seg ${segIdx}] ✅ Prompt successfully entered and verified.`);
              break;
            } else {
              console.log(`[${STEP_NAME}] [Seg ${segIdx}] WARNING: Tried to fill prompt but it remained empty. Retrying...`);
            }
          }
        } catch { }
      }
      if (promptEntered) break;
      await humanDelay(1000, 2000);
    }

    if (!promptEntered) {
      await debugScreenshot(page, `${label}_prompt_fail`);
      console.log(`[${STEP_NAME}] [Seg ${segIdx}] ❌ Failed to verify prompt was entered, but proceeding anyway.`);
    }

    await debugScreenshot(page, `${label}_03b_prompt_entered`);
  }
  await humanDelay(1000, 2000);

  // ── Select Portrait & 1x Option ──
  console.log(`[${STEP_NAME}] [Seg ${segIdx}] Selecting Portrait and 1x options...`);
  try {
    const dropdownBtnSelectors = [
      "button:has-text('x2')",
      "div:has-text('x2')",
      "[aria-label*='x2']",
      "button:has-text('Video')", 
      // Sometimes it says "16:9", "Landscape", or "1:1" if previously changed
      "button:has-text('16:9')",
      "button:has-text('1:1')",
      "button:has-text('9:16')",
      "button:has-text('Landscape')",
      "button:has-text('Square')"
    ];

    let dropdownOpened = false;
    for (const sel of dropdownBtnSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1000 })) {
        await btn.click();
        dropdownOpened = true;
        await humanDelay(500, 1000);
        break;
      }
    }

    if (dropdownOpened) {
      // 1. Select Portrait
      const portraitOptions = [
        "text='Portrait'",
        "text='9:16'",
        "div[role='option']:has-text('Portrait')",
        "button:has-text('Portrait')"
      ];
      for (const sel of portraitOptions) {
        const opt = page.locator(sel).last(); 
        if (await opt.isVisible({ timeout: 1000 })) {
            await opt.click();
            console.log(`[${STEP_NAME}] [Seg ${segIdx}] ✅ Selected Portrait (9:16) orientation.`);
            await humanDelay(300, 500); // give UI time to stabilize
            break;
        }
      }

      // 2. Select 1x
      const oneXOptions = [
        "text='1x'", "text='x1'", "text='1'", 
        "div[role='option']:has-text('1')",
        "button:has-text('1x')",
        "button:has-text('1')"
      ];
      for (const sel of oneXOptions) {
        const opt = page.locator(sel).last(); 
        if (await opt.isVisible({ timeout: 1000 })) {
            await opt.click();
            console.log(`[${STEP_NAME}] [Seg ${segIdx}] ✅ Selected 1x generation from picker.`);
            break;
        }
      }
    } else {
      console.log(`[${STEP_NAME}] [Seg ${segIdx}] Warning: Format/Quantity button not found.`);
    }
  } catch (err) {
    console.log(`[${STEP_NAME}] [Seg ${segIdx}] Warning: Error changing Portrait/1x option: ${err.message}`);
  }

  // ── Click Create ──
  console.log(`[${STEP_NAME}] [Seg ${segIdx}] Clicking Create...`);
  const createSelectors = [
    "button:has-text('Create')",
    "button[aria-label='Create']",
    "button:has-text('arrow_forward')",
    // the circular right arrow button at the bottom right
    "button.send-button",
    "button[type='submit']"
  ];
  let created = false;
  for (const sel of createSelectors) {
    try {
      const el = page.locator(sel).first();
      // Ensure the button is enabled before clicking
      if (await el.isVisible({ timeout: 2000 }) && await el.isEnabled()) {
        await el.click();
        created = true;
        break;
      }
    } catch { }
  }
  if (!created) {
    // Fallback: press Enter on keyboard if focused in prompt
    try {
      await page.keyboard.press("Enter");
      created = true;
      console.log(`[${STEP_NAME}] [Seg ${segIdx}] Flow create button not found, pressed Enter.`);
    } catch { }
  }
  if (!created) {
    await debugScreenshot(page, `${label}_create_fail`);
    throw new Error(`[Seg ${segIdx}] Could not click Create.`);
  }
  console.log(`[${STEP_NAME}] [Seg ${segIdx}] ✅ Create clicked. Waiting for generation...`);
  await humanDelay(2000, 4000);
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
