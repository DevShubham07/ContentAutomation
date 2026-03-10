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

const PROMPT = (theme) => `Output ONLY valid JSON.
No explanation.
No markdown.
No code fences.

ROLE

You are an elite Instagram Reels creative director whose job is to design reels that maximize:

• viewer retention
• completion rate
• rewatchability
• emotional impact

Your output will power an automated AI video generation pipeline.

USER IDEA
${theme}

REEL SPECIFICATIONS

Total Duration: ${TOTAL_DURATION_S} seconds

The reel will be built using:

• ${FRAME_COUNT} key images (portrait 9:16)
• ${VIDEO_COUNT} interpolated videos between frames
• each video duration: ${VIDEO_DURATION_S} seconds
• final stitched reel length: ${TOTAL_DURATION_S} seconds
• an emotional Hindi voiceover plays across the entire reel

VERY IMPORTANT

All frames MUST depict:

• the SAME subject
• the SAME environment
• the SAME scene

KIDS SAFETY & STYLE:
• NEVER use photorealism or real photos for kids.
• Use 3D animation, stylized art, or cinematic illustration style for any children.

Only time progression and emotional evolution should change.

This ensures smooth video interpolation.

---

VIRAL STORY STRUCTURE

The reel must follow this psychological arc:

Frame 1 — SCROLL STOPPING HOOK  
Frame 2 — VISUAL / EMOTIONAL ESCALATION  
Frame 3 — POWERFUL PAYOFF / REALIZATION  

The viewer should feel curiosity in the beginning and emotional satisfaction at the end.

---

VIRAL PATTERN

Choose ONE storytelling pattern internally:

• transformation
• discovery
• contrast
• illusion reveal
• emotional realization
• journey
• perspective shift

Use this pattern to shape the scene progression.

---

HOOK DESIGN RULES

Frame 1 must immediately grab attention using at least one:

• unusual perspective
• glowing elements
• dramatic lighting
• mysterious subject
• surreal moment
• powerful emotion
• unexpected visual contrast

The viewer should feel curiosity in the first second.

---

VISUAL STYLE

Use cinematic imagery including:

• dramatic lighting
• volumetric fog
• neon glow
• atmospheric particles
• shallow depth of field
• wide angle or cinematic close-ups
• rich color contrast
• highly detailed environment

---

LOOP DESIGN (VERY IMPORTANT)

The final frame should visually resemble or connect to the opening frame so the reel can loop naturally when replayed.

This increases rewatch rate and virality.

---

OUTPUT FORMAT

Return a JSON object with EXACTLY three fields.

1. "framePrompts"

Array of exactly ${FRAME_COUNT} strings.

framePrompts[0]
Scroll-stopping opening frame.

framePrompts[1]
The escalation moment where the scene evolves emotionally or visually.

framePrompts[2]
The final satisfying or meaningful moment.

All frames must depict the same environment and subject with natural progression through time.

Each prompt must be highly cinematic and visually descriptive.

---

2. "videoPrompts"

Array of exactly ${VIDEO_COUNT} strings describing motion between frames.

videoPrompts[0]
Motion and transition from frame 1 → frame 2.

videoPrompts[1]
Motion and transition from frame 2 → frame 3.

Describe:

• camera movement
• subject motion
• environmental evolution
• emotional tone

---

3. "audioScript"

A poetic Hindi narration written in Devanagari script.

Requirements:

• emotional storytelling tone
• philosophical / heartfelt narration
• approximately ${Math.round(TOTAL_DURATION_S * 2.4)} words
• natural spoken Hindi rhythm
• enhances the visual journey

The narration should feel like a meaningful thought or realization.

---

Return ONLY the raw JSON object.
`;

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

export async function generatePlan(page, theme, logger) {
  const log = (msg) => {
    if (logger) logger.log(msg);
    else console.log(`[${STEP_NAME}] ${msg}`);
  };

  if (!page || !theme) {
    throw new Error("page and theme (non-empty string) are required");
  }

  log(`Generating plan for theme: "${theme}"...`);
  const planPath = path.resolve(process.cwd(), PLAN_PATH);
  const MAX_PROMPT_ATTEMPTS = 3;

  return retry(async () => {
    // ── Navigate & get ChatGPT ready (retried by outer retry on failure) ──
    try {
      log(`Navigating to ${CHATGPT_URL}...`);
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
