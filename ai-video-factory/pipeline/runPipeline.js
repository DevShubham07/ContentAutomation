import path from "node:path";
import { spawn } from "node:child_process";
import fs from "fs-extra";
import { launchBrowser, releaseBrowserbaseSession, getOrReusePage } from "../utils/browser.js";
import { humanDelay } from "../utils/delay.js";
import { generatePlan } from "../steps/generatePlan.js";
import { generateImages } from "../steps/generateImages.js";
import { createVideo } from "../steps/createVideo.js";
import { generateAudio } from "../steps/generateAudio.js";
import { mergeVideo } from "../steps/merge.js";

const FRAMES_DIR = "./assets/frames";
const VIDEO_PATH = "./assets/video/output.mp4";
const AUDIO_PATH = "./assets/audio/narration.mp3";
const FINAL_PATH = "./assets/final.mp4";

const STAGES = {
  GPT_PLAN: "Generating GPT Plan",
  IMAGES: "Generating Images",
  VIDEO: "Creating Video",
  AUDIO: "Generating Audio",
  MERGE: "Merging Final Video",
  COMPLETED: "Completed",
};

const STEP_ORDER = ["gpt", "images", "video", "audio", "merge"];
const MAX_STEP_ATTEMPTS = 3;

function isRecoverableSiteError(message) {
  const msg = (message || "").toLowerCase();
  return (
    msg.includes("timeout") ||
    msg.includes("429") ||
    msg.includes("concurrent sessions limit") ||
    msg.includes("target page, context or browser has been closed") ||
    msg.includes("login") ||
    msg.includes("selector") ||
    msg.includes("navigating to") ||
    msg.includes("net::") ||
    msg.includes("closed")
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runPipeline(jobId, theme, broadcast) {
  const { getJob, updateJob, appendJobLog, appendJobDiagnostic, clearPauseRequest, clearAbortRequest } =
    await import("../jobs.js");

  const job = getJob(jobId);
  if (!job) {
    throw new Error(`Job not found: ${jobId}`);
  }

  let browser;
  let browserContext;
  let grokContext;
  let flowContext;
  let elevenContext;

  const cleanup = async () => {
    const close = async (obj) => {
      if (obj) await obj.close().catch(() => { });
    };
    // Only close separate contexts if they differ from the main browserContext
    if (grokContext && grokContext !== browserContext) await close(grokContext);
    if (flowContext && flowContext !== browserContext) await close(flowContext);
    if (elevenContext && elevenContext !== browserContext) await close(elevenContext);
    await close(browserContext);
    if (browser) await close(browser);
  };

  const log = (msg) => {
    const line = `[Job ${jobId.slice(0, 8)}] ${msg}`;
    console.log(line);
    appendJobLog(jobId, msg);
  };

  const isAbortRequested = () => Boolean(getJob(jobId)?.control?.abortRequested);
  const isPauseRequested = () => Boolean(getJob(jobId)?.control?.pauseRequested);

  async function captureDiagnostic(step, attempt, err, pageLike) {
    const message = err?.message || String(err);
    const stamp = Date.now();
    const diagnosticsDir = path.resolve(process.cwd(), "assets/diagnostics");
    await fs.ensureDir(diagnosticsDir);

    let screenshotPath = null;
    let url = null;
    const page = pageLike ?? browserContext?.pages?.()?.[0] ?? null;
    if (page) {
      try {
        url = page.url();
      } catch { }
      try {
        screenshotPath = path.join(diagnosticsDir, `${jobId}_${step}_a${attempt}_${stamp}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });
      } catch { }
    }

    appendJobDiagnostic(jobId, {
      step,
      attempt,
      error: message,
      url,
      screenshotPath,
      recoverable: isRecoverableSiteError(message),
    });
  }

  async function pauseJob(step, attempt, reason, stageLabel) {
    updateJob(jobId, {
      status: "paused",
      currentStep: step,
      stepIndex: STEP_ORDER.indexOf(step),
      attempt,
      lastError: reason,
      actionRequired: `Manual check required for step "${step}": ${reason}`,
      progress: getJob(jobId)?.progress ?? 0,
    });
    broadcast(jobId, stageLabel || "paused", {
      state: "paused",
      step,
      attempt,
      error: reason,
      actionRequired: getJob(jobId)?.actionRequired,
      browserbase: getJob(jobId)?.data?.browserbase ?? {},
    });
    log(`PAUSED at "${step}" (attempt ${attempt}): ${reason}`);
  }

  async function runStepWithRetry({ step, stage, progressBefore, progressAfter, run }) {
    for (let attempt = 1; attempt <= MAX_STEP_ATTEMPTS; attempt++) {
      if (isAbortRequested()) {
        throw new Error("PIPELINE_ABORTED");
      }
      if (isPauseRequested()) {
        await pauseJob(step, attempt, "Pause requested by operator", stage);
        return { paused: true };
      }

      updateJob(jobId, {
        status: "running",
        currentStep: step,
        stepIndex: STEP_ORDER.indexOf(step),
        attempt,
        lastError: null,
        actionRequired: null,
        progress: progressBefore,
      });
      broadcast(jobId, stage, { step, attempt });

      try {
        log(`Step "${step}" attempt ${attempt}/${MAX_STEP_ATTEMPTS}`);
        await run();
        updateJob(jobId, {
          attempt: 0,
          lastError: null,
          actionRequired: null,
          progress: progressAfter,
        });
        return { paused: false };
      } catch (err) {
        const message = err?.message || String(err);
        updateJob(jobId, { lastError: message, attempt });
        await captureDiagnostic(step, attempt, err);

        if (isAbortRequested()) {
          throw new Error("PIPELINE_ABORTED");
        }

        const recoverable = isRecoverableSiteError(message);
        const canRetry = recoverable && attempt < MAX_STEP_ATTEMPTS;
        if (canRetry) {
          const waitMs = 1000 * Math.pow(2, attempt);
          log(`Recoverable error on "${step}", retrying in ${waitMs}ms: ${message}`);
          await sleep(waitMs);
          continue;
        }

        if (recoverable) {
          await pauseJob(step, attempt, message, stage);
          return { paused: true };
        }

        throw err;
      }
    }

    await pauseJob(step, MAX_STEP_ATTEMPTS, "Retries exhausted", stage);
    return { paused: true };
  }

  try {
    clearPauseRequest(jobId);
    clearAbortRequest(jobId);

    const currentJob = getJob(jobId);
    const startIndex =
      currentJob?.status === "paused" && Number.isInteger(currentJob?.stepIndex) && currentJob.stepIndex >= 0
        ? currentJob.stepIndex
        : 0;

    const resolvedTheme = (theme || currentJob?.theme || "").trim();
    if (!resolvedTheme) {
      throw new Error("Theme is required");
    }

    updateJob(jobId, {
      theme: resolvedTheme,
      status: "running",
      progress: currentJob?.progress ?? 10,
      currentStep: STEP_ORDER[startIndex],
      stepIndex: startIndex,
      actionRequired: null,
      lastError: null,
    });
    log(`Starting pipeline from step "${STEP_ORDER[startIndex]}"...`);

    const previousSessionId = currentJob?.data?.browserbase?.sessionId;
    if (previousSessionId) {
      await releaseBrowserbaseSession(previousSessionId);
    }

    log("Launching Browserbase session...");
    let launchAttemptError = null;
    let launchResult = null;
    for (let attempt = 1; attempt <= MAX_STEP_ATTEMPTS; attempt++) {
      if (isAbortRequested()) {
        throw new Error("PIPELINE_ABORTED");
      }
      try {
        launchResult = await launchBrowser();
        break;
      } catch (err) {
        launchAttemptError = err;
        const message = err?.message || String(err);
        appendJobDiagnostic(jobId, {
          step: "launch",
          attempt,
          error: message,
          recoverable: isRecoverableSiteError(message),
        });
        if (isRecoverableSiteError(message) && attempt < MAX_STEP_ATTEMPTS) {
          const waitMs = 1000 * Math.pow(2, attempt);
          log(`Recoverable launch error, retrying in ${waitMs}ms: ${message}`);
          await sleep(waitMs);
          continue;
        }
        if (isRecoverableSiteError(message)) {
          await pauseJob("launch", attempt, message, "launch");
          await cleanup();
          return;
        }
        throw err;
      }
    }
    if (!launchResult) {
      throw launchAttemptError || new Error("Failed to launch browser");
    }

    browser = launchResult.browser;
    const { context, liveUrl, sessionId, replayUrl, contextId } = launchResult;
    browserContext = context;
    log("Browser connected.");
    updateJob(jobId, {
      "data.browserbase": {
        sessionId: sessionId ?? null,
        replayUrl: replayUrl ?? null,
        liveUrl: liveUrl ?? null,
        contextId: contextId ?? null,
      },
    });

    if (liveUrl && process.platform === "darwin") {
      log(`Opening Browserbase live view in browser...`);
      spawn("open", [liveUrl], { detached: true, stdio: "ignore" }).unref();
    }

    const gptPage = await getOrReusePage(browserContext, "https://chatgpt.com");
    // All steps share the same browserContext so they can find and reuse
    // the login tabs opened by `npm run login`.
    grokContext = browserContext;
    flowContext = browserContext;
    elevenContext = browserContext;

    let plan = getJob(jobId)?.data?.gptJson ?? null;

    const steps = [
      {
        step: "gpt",
        stage: STAGES.GPT_PLAN,
        progressBefore: 10,
        progressAfter: 20,
        run: async () => {
          log("Stage: Generating GPT Plan...");
          plan = await generatePlan(gptPage, resolvedTheme);
          updateJob(jobId, { "data.gptJson": plan });
          broadcast(jobId, STAGES.GPT_PLAN, { json: plan });
          log("GPT Plan done.");
          await humanDelay(1000, 2500);
        },
      },
      {
        step: "images",
        stage: STAGES.IMAGES,
        progressBefore: 30,
        progressAfter: 50,
        run: async () => {
          if (!plan) throw new Error("Missing plan data before image generation");
          log("Stage: Generating Images...");
          await generateImages(grokContext, plan.framePrompts);
          const framesDir = path.resolve(process.cwd(), FRAMES_DIR);
          const frameFiles = (await fs.readdir(framesDir))
            .filter((f) => f.match(/^frame_\d{4}\.png$/i))
            .sort()
            .map((f) => path.join(framesDir, f));
          updateJob(jobId, { "data.images": frameFiles });
          broadcast(jobId, STAGES.IMAGES, { images: frameFiles });
          log("Images done.");
          await humanDelay(1000, 2500);
        },
      },
      {
        step: "video",
        stage: STAGES.VIDEO,
        progressBefore: 60,
        progressAfter: 70,
        run: async () => {
          log("Stage: Creating Video...");
          const videoPrompt = plan?.videoPrompt || "Smooth cinematic transition between the two frames";
          await createVideo(flowContext, videoPrompt);
          const videoPath = path.resolve(process.cwd(), VIDEO_PATH);
          updateJob(jobId, { "data.videoPath": videoPath });
          broadcast(jobId, STAGES.VIDEO, { videoPath });
          log("Video done.");
          await humanDelay(1000, 2500);
        },
      },
      {
        step: "audio",
        stage: STAGES.AUDIO,
        progressBefore: 75,
        progressAfter: 85,
        run: async () => {
          if (!plan) throw new Error("Missing plan data before audio generation");
          log("Stage: Generating Audio...");
          await generateAudio(elevenContext, plan.audioPrompt);
          const audioPath = path.resolve(process.cwd(), AUDIO_PATH);
          updateJob(jobId, { "data.audioPath": audioPath });
          broadcast(jobId, STAGES.AUDIO, { audioPath });
          log("Audio done.");
          await humanDelay(500, 1200);
        },
      },
      {
        step: "merge",
        stage: STAGES.MERGE,
        progressBefore: 90,
        progressAfter: 95,
        run: async () => {
          log("Stage: Merging final video...");
          await mergeVideo();
          const finalPath = path.resolve(process.cwd(), FINAL_PATH);
          updateJob(jobId, { "data.finalPath": finalPath });
          broadcast(jobId, STAGES.MERGE, { finalPath });
          log("Merge done.");
        },
      },
    ];

    for (let i = startIndex; i < steps.length; i++) {
      const outcome = await runStepWithRetry(steps[i]);
      if (outcome.paused) {
        await cleanup();
        return;
      }
    }

    const finalPath = path.resolve(process.cwd(), FINAL_PATH);
    updateJob(jobId, {
      status: "completed",
      currentStep: null,
      stepIndex: STEP_ORDER.length,
      progress: 100,
      attempt: 0,
      actionRequired: null,
      lastError: null,
      "data.finalPath": finalPath,
    });
    broadcast(jobId, STAGES.COMPLETED, { finalPath });
    log("Pipeline completed.");

    await cleanup();
  } catch (err) {
    const errMsg = err?.message || String(err);
    if (errMsg === "PIPELINE_ABORTED") {
      updateJob(jobId, {
        status: "aborted",
        actionRequired: null,
        lastError: null,
      });
      broadcast(jobId, "aborted", { state: "aborted" });
      log("Pipeline aborted by operator.");
      await cleanup();
      return;
    }

    log(`FAILED: ${errMsg}`);
    const errorMessage = err.message || String(err);
    const failedJob = getJob(jobId);
    updateJob(jobId, {
      status: "failed",
      currentStep: failedJob?.currentStep ?? null,
      progress: failedJob?.progress ?? 0,
      lastError: errorMessage,
      actionRequired: null,
    });
    broadcast(jobId, "failed", { error: errorMessage });
    await cleanup();
    throw err;
  }
}
