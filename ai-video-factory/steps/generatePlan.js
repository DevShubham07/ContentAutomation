import path from "node:path";
import fs from "fs-extra";
import { retry } from "../utils/retry.js";
import { humanDelay } from "../utils/delay.js";
import { waitForNetworkIdle } from "../utils/networkIdle.js";
import { classifyStepError, inferLoginRequired } from "../utils/stepGuards.js";

const STEP_NAME = "generatePlan";

const CHATGPT_URL = "https://chatgpt.com";
const LOGIN_WAIT_MS = 300_000;
const RESPONSE_WAIT_MS = 180_000; // 3 min — 72 frame prompts is a large response
const STREAMING_POLL_MS = 2_000;
const STABILIZATION_ROUNDS = 3;   // text must be unchanged for this many checks
const STABILIZATION_INTERVAL_MS = 2_000;
const PLAN_PATH = "./assets/plan.json";

const FRAME_COUNT = 3;
const VIDEO_COUNT = FRAME_COUNT - 1; // 2 videos between 3 frames
const VIDEO_DURATION_S = 8; // each Flow video is ~8 seconds
const TOTAL_DURATION_S = VIDEO_COUNT * VIDEO_DURATION_S; // 16 seconds total

const PROMPT = (theme) => `Output ONLY valid JSON, no other text or markdown. No code fences, no explanation.

You are a creative Instagram Reels content creator. The user will give you a rough idea/theme. Your job is to IMPROVISE on it — think like a trending content creator, elevate the concept, make it visually stunning and scroll-stopping.

User's idea: ${theme}

You need to produce content for a short Instagram Reel (about ${TOTAL_DURATION_S} seconds). The reel will be made by:
1. Generating ${FRAME_COUNT} KEY IMAGES (portrait 9:16) that represent key moments in the reel
2. Between each consecutive pair of images, a video will be interpolated (${VIDEO_COUNT} videos total, ${VIDEO_DURATION_S}s each)
3. The videos will be stitched together into one seamless ${TOTAL_DURATION_S}-second reel
4. An emotional Hindi voiceover will play over the final video

Generate a JSON object with exactly:
1. "framePrompts": array of exactly ${FRAME_COUNT} strings:
   - framePrompts[0] = OPENING frame — the hook that grabs attention
   - framePrompts[1] = MIDDLE frame — the emotional peak or turning point
   - framePrompts[2] = CLOSING frame — the satisfying conclusion
   All prompts should describe the same scene/subject at different moments in time, so smooth video interpolation is possible between consecutive frames. Be extremely descriptive about lighting, colors, camera angle, composition, and mood. Use cinematic language.
2. "videoPrompts": array of exactly ${VIDEO_COUNT} strings:
   - videoPrompts[0] = motion/transition from frame 1 to frame 2 (e.g. "camera slowly pushes in as...")
   - videoPrompts[1] = motion/transition from frame 2 to frame 3
   Each should describe camera movement, subject motion, and how the scene evolves.
3. "audioScript": a single string — an emotional, traditional, heart-touching Hindi voiceover script. Exactly ${TOTAL_DURATION_S} seconds when spoken. Write in Devanagari Hindi. It should feel like a storytelling narration — poetic, warm, and deeply emotional. NOT a translation of English, but authentic Hindi poetry/prose.

Return only the raw JSON object.`;

/* ── JSON helpers (unchanged) ────────────────────────────────────────── */

function extractJsonBlock(text) {
  if (!text || typeof text !== "string") return null;
  let cleaned = text.trim();

  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    cleaned = cleaned.slice(start, end + 1);
  }

  return cleaned || null;
}

function sanitizeJsonForParsing(input) {
  if (!input || typeof input !== "string") return input;

  let out = input.replace(/^\uFEFF/, "");
  let repaired = "";
  let inString = false;
  let escaped = false;

  for (const ch of out) {
    if (escaped) {
      repaired += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      repaired += ch;
      escaped = true;
      continue;
    }

    if (ch === '"') {
      repaired += ch;
      inString = !inString;
      continue;
    }

    if (inString) {
      if (ch === "\n") { repaired += "\\n"; continue; }
      if (ch === "\r") { repaired += "\\r"; continue; }
      if (ch === "\t") { repaired += "\\t"; continue; }
      if (ch.charCodeAt(0) < 0x20) { repaired += " "; continue; }
    }

    repaired += ch;
  }

  repaired = repaired.replace(/,\s*([}\]])/g, "$1");
  return repaired;
}

function parsePlanJson(text) {
  const raw = extractJsonBlock(text);
  if (!raw) {
    throw new Error("No JSON block found in response");
  }
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) {
    throw new Error(
      `Response does not contain valid JSON (starts with "${trimmed.slice(0, 30).replace(/"/g, "'")}..."). ` +
      "ChatGPT may have returned HTML or plain text instead of JSON."
    );
  }
  try {
    return JSON.parse(raw);
  } catch (firstErr) {
    const repaired = sanitizeJsonForParsing(raw);
    try {
      return JSON.parse(repaired);
    } catch (secondErr) {
      throw new Error(
        `Invalid JSON after repair attempt: ${secondErr.message}. ` +
        `Original parse error: ${firstErr.message}.`
      );
    }
  }
}

function validatePlan(plan) {
  if (!plan || typeof plan !== "object") {
    throw new Error("Plan must be an object");
  }
  if (!Array.isArray(plan.framePrompts) || plan.framePrompts.length !== FRAME_COUNT) {
    throw new Error(`Plan must have framePrompts array with exactly ${FRAME_COUNT} items`);
  }
  if (!Array.isArray(plan.videoPrompts) || plan.videoPrompts.length !== VIDEO_COUNT) {
    // Backwards compat: if old single videoPrompt exists, convert it
    if (typeof plan.videoPrompt === "string") {
      plan.videoPrompts = [plan.videoPrompt, plan.videoPrompt];
      console.warn(`[${STEP_NAME}] Converted legacy videoPrompt to videoPrompts array.`);
    } else {
      throw new Error(`Plan must have videoPrompts array with exactly ${VIDEO_COUNT} items`);
    }
  }
  if (typeof plan.audioScript !== "string" || plan.audioScript.length < 10) {
    // Fallback: use audioPrompt if audioScript is missing
    if (typeof plan.audioPrompt === "string" && plan.audioPrompt.length >= 10) {
      plan.audioScript = plan.audioPrompt;
      console.warn(`[${STEP_NAME}] Using audioPrompt as audioScript fallback.`);
    } else {
      throw new Error("Plan must have audioScript string (Hindi voiceover, at least 10 chars)");
    }
  }
  return plan;
}

/* ── ChatGPT readiness ───────────────────────────────────────────────── */

async function waitUntilChatGPTReady(page) {
  const maxWait = LOGIN_WAIT_MS;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    const url = page.url().toLowerCase();
    const bodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();

    const isChallengePage =
      bodyText.includes("verify you are human") ||
      bodyText.includes("checking your browser") ||
      bodyText.includes("just a moment") ||
      bodyText.includes("security check") ||
      url.includes("/api/auth/error");

    if (isChallengePage) {
      console.log(`[${STEP_NAME}] Cloudflare challenge detected, waiting for it to clear...`);
      await humanDelay(3000, 5000);
      continue;
    }

    const textarea = page.locator("#prompt-textarea");
    const visible = await textarea.isVisible().catch(() => false);
    if (visible) {
      return;
    }

    const loginRequired = await inferLoginRequired(page);
    if (loginRequired) {
      throw new Error('Login required on ChatGPT (selector "#prompt-textarea" not available)');
    }

    await humanDelay(2000, 3000);
  }

  throw new Error(`ChatGPT did not become ready within ${maxWait / 1000}s`);
}

/* ── Streaming completion detection ──────────────────────────────────── */

/**
 * Wait for ChatGPT to finish streaming its response.
 *
 * Detection strategy (in priority order):
 * 1. The send-button (data-testid="send-button") reappears — during streaming
 *    ChatGPT replaces it with a stop button.
 * 2. A stop-streaming button disappears.
 * 3. Fallback: the assistant message text stabilises (unchanged for several rounds).
 */
async function waitForStreamingComplete(page, timeoutMs = RESPONSE_WAIT_MS) {
  const start = Date.now();

  // Phase 1: Wait for at least one assistant message to appear
  console.log(`[${STEP_NAME}] Waiting for assistant response to begin...`);
  while (Date.now() - start < timeoutMs) {
    const hasAssistant = await page.locator('[data-message-author-role="assistant"]')
      .first().isVisible().catch(() => false);
    if (hasAssistant) break;
    await new Promise((r) => setTimeout(r, STREAMING_POLL_MS));
  }

  // Phase 2: Wait for streaming to finish
  console.log(`[${STEP_NAME}] Response started, waiting for streaming to complete...`);

  let stableCount = 0;
  let previousText = "";

  while (Date.now() - start < timeoutMs) {
    // Check 1: Send button reappeared (most reliable signal)
    const sendButton = page.getByTestId("send-button");
    const sendVisible = await sendButton.isVisible().catch(() => false);
    if (sendVisible) {
      // Also verify no stop button is still visible
      const stopBtn = page.locator('button[aria-label="Stop streaming"], button[data-testid="stop-button"]').first();
      const stopVisible = await stopBtn.isVisible().catch(() => false);
      if (!stopVisible) {
        console.log(`[${STEP_NAME}] Streaming complete (send button reappeared).`);
        return;
      }
    }

    // Check 2: No stop/streaming indicators present
    const stopButton = page.locator(
      'button[aria-label="Stop streaming"], button[data-testid="stop-button"], button[aria-label="Stop generating"]'
    ).first();
    const stopVisible = await stopButton.isVisible().catch(() => false);

    // Check 3: Text stabilisation fallback
    const currentText = await page.locator('[data-message-author-role="assistant"]')
      .last()
      .innerText()
      .catch(() => "");

    if (currentText && currentText === previousText) {
      stableCount++;
      // If there's no stop button AND text is stable, we're done
      if (!stopVisible && stableCount >= STABILIZATION_ROUNDS) {
        console.log(`[${STEP_NAME}] Streaming complete (text stabilised for ${STABILIZATION_ROUNDS} checks).`);
        return;
      }
    } else {
      stableCount = 0;
      previousText = currentText;
    }

    await new Promise((r) => setTimeout(r, STABILIZATION_INTERVAL_MS));
  }

  // If we reach here the timeout expired; continue anyway with whatever text exists
  console.warn(`[${STEP_NAME}] Streaming detection timed out after ${timeoutMs / 1000}s — attempting extraction anyway.`);
}

/* ── Extract the full response text from the page ────────────────────── */

async function extractAssistantResponse(page) {
  // Try the last assistant message first (most reliable)
  const assistantMessages = page.locator('[data-message-author-role="assistant"]');
  const count = await assistantMessages.count();

  if (count > 0) {
    const lastMessage = assistantMessages.nth(count - 1);
    const text = await lastMessage.innerText().catch(() => "");
    if (text && text.includes("{") && text.includes("}")) {
      return text;
    }
  }

  // Fallback: look in pre/code blocks
  const codeBlocks = page.locator("pre, code");
  const codeCount = await codeBlocks.count();
  for (let i = codeCount - 1; i >= 0; i--) {
    const text = await codeBlocks.nth(i).innerText().catch(() => "");
    if (text && text.includes("{") && text.includes("}") &&
      (text.includes("framePrompts") || text.includes("audioPrompt"))) {
      return text;
    }
  }

  return null;
}

/* ── Main export ─────────────────────────────────────────────────────── */

export async function generatePlan(page, theme, options = {}) {
  if (!page || !theme) {
    throw new Error("page and theme are required");
  }

  const planPath = path.resolve(process.cwd(), PLAN_PATH);
  const MAX_PROMPT_ATTEMPTS = 3;

  return retry(async () => {
    // ── Navigate & get ChatGPT ready (retried by outer retry on failure) ──
    try {
      console.log(`[${STEP_NAME}] Navigating to ${CHATGPT_URL}...`);
      await page.goto(CHATGPT_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
      console.log(`[${STEP_NAME}] Page loaded, waiting for network idle...`);
      await waitForNetworkIdle(page, 15_000);
      await humanDelay(800, 1800);

      console.log(`[${STEP_NAME}] Waiting for ChatGPT to be ready...`);
      await waitUntilChatGPTReady(page);
    } catch (navErr) {
      const msg = classifyStepError(STEP_NAME, navErr);
      throw new Error(msg);
    }

    // ── Send prompt & extract response (retried in-page without re-navigation) ──
    let lastParseError = null;

    for (let attempt = 1; attempt <= MAX_PROMPT_ATTEMPTS; attempt++) {
      try {
        const textarea = page.locator("#prompt-textarea");
        await humanDelay(400, 900);

        console.log(`[${STEP_NAME}] Filling prompt and sending (attempt ${attempt}/${MAX_PROMPT_ATTEMPTS})...`);
        await textarea.fill(PROMPT(theme));
        await humanDelay(300, 700);
        await page.getByTestId("send-button").click();

        // ── Wait for streaming to complete ──
        await waitForStreamingComplete(page, RESPONSE_WAIT_MS);

        // Extra stabilisation delay for any final DOM updates
        await humanDelay(2000, 3000);

        // ── Extract the complete response ──
        console.log(`[${STEP_NAME}] Extracting response...`);
        const responseText = await extractAssistantResponse(page);

        if (!responseText) {
          throw new Error("No assistant response found on the page after streaming completed");
        }

        const plan = validatePlan(parsePlanJson(responseText));

        await fs.ensureDir(path.dirname(planPath));
        await fs.writeJson(planPath, plan, { spaces: 2 });
        console.log(`[${STEP_NAME}] plan.json saved successfully.`);

        return plan;
      } catch (err) {
        lastParseError = err;
        console.warn(`[${STEP_NAME}] Attempt ${attempt} failed: ${err.message}`);

        if (attempt < MAX_PROMPT_ATTEMPTS) {
          // Wait for ChatGPT to be ready again before re-sending the prompt
          console.log(`[${STEP_NAME}] Waiting for ChatGPT to become ready for re-prompt...`);
          await humanDelay(2000, 4000);
          try {
            await waitUntilChatGPTReady(page);
          } catch {
            // If ChatGPT isn't ready, break out to the outer retry which will re-navigate
            break;
          }
        }
      }
    }

    // All in-page attempts failed — throw so the outer retry re-navigates
    const msg = classifyStepError(STEP_NAME, lastParseError || new Error("All prompt attempts failed"));
    throw new Error(msg);
  }, 3, 2000);
}
