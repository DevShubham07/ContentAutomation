import path from "node:path";
import fs from "fs-extra";
import { retry } from "../utils/retry.js";
import { humanDelay } from "../utils/delay.js";
import { waitForNetworkIdle } from "../utils/networkIdle.js";
import { classifyStepError, inferLoginRequired } from "../utils/stepGuards.js";

const STEP_NAME = "generatePlan";

const CHATGPT_URL = "https://chatgpt.com";
const LOGIN_WAIT_MS = 300_000; // 5 min for manual login
const RESPONSE_WAIT_MS = 120_000; // 2 min for response
const PLAN_PATH = "./assets/plan.json";

const PROMPT = (theme) => `Output ONLY valid JSON, no other text or markdown. No code fences, no explanation.

Theme: ${theme}
Duration: 6 seconds
Frame rate: 12 fps
Total frames: 72

Generate a JSON object with exactly:
1. "framePrompts": array of 72 strings, one prompt per frame for image generation
2. "audioPrompt": single string for voice narration/speech synthesis

Return only the raw JSON object.`;

function extractJsonBlock(text) {
  if (!text || typeof text !== "string") return null;
  let cleaned = text.trim();

  // Remove markdown code fences
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  // Fallback: find first { to last }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    cleaned = cleaned.slice(start, end + 1);
  }

  return cleaned || null;
}

function parsePlanJson(text) {
  const raw = extractJsonBlock(text);
  if (!raw) {
    throw new Error("No JSON block found in response");
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON: ${err.message}`);
  }
}

function validatePlan(plan) {
  if (!plan || typeof plan !== "object") {
    throw new Error("Plan must be an object");
  }
  if (!Array.isArray(plan.framePrompts) || plan.framePrompts.length !== 72) {
    throw new Error("Plan must have framePrompts array with exactly 72 items");
  }
  if (typeof plan.audioPrompt !== "string") {
    throw new Error("Plan must have audioPrompt string");
  }
  return plan;
}

export async function generatePlan(page, theme) {
  if (!page || !theme) {
    throw new Error("page and theme are required");
  }

  const planPath = path.resolve(process.cwd(), PLAN_PATH);

  return retry(async () => {
    try {
      console.log(`[${STEP_NAME}] Navigating to ${CHATGPT_URL}...`);
      await page.goto(CHATGPT_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
      console.log(`[${STEP_NAME}] Page loaded, waiting for network idle...`);
      await waitForNetworkIdle(page, 15_000);
      await humanDelay(800, 1800);

      console.log(`[${STEP_NAME}] Waiting for prompt textarea (up to ${LOGIN_WAIT_MS / 1000}s)...`);
      const textarea = page.locator("#prompt-textarea");
      try {
        await textarea.waitFor({ state: "visible", timeout: LOGIN_WAIT_MS });
      } catch (err) {
        const loginRequired = await inferLoginRequired(page);
        if (loginRequired) {
          throw new Error('Login required on ChatGPT (selector "#prompt-textarea" not available)');
        }
        throw err;
      }
      await humanDelay(400, 900);

      console.log(`[${STEP_NAME}] Filling prompt and sending...`);
      await textarea.fill(PROMPT(theme));
      await humanDelay(300, 700);
      await page.getByTestId("send-button").click();

      console.log(`[${STEP_NAME}] Waiting for ChatGPT response (up to ${RESPONSE_WAIT_MS / 1000}s)...`);
      const responseHandle = await page.waitForFunction(
        () => {
          const candidates = [
            ...document.querySelectorAll('[data-message-author-role="assistant"]'),
            ...document.querySelectorAll("pre, code"),
          ];
          for (const el of candidates) {
            const text = el.textContent || "";
            if (text.includes("{") && text.includes("}") && (text.includes("framePrompts") || text.includes("audioPrompt"))) {
              return text;
            }
          }
          const body = document.body?.innerText || "";
          if (body.includes('"framePrompts"') && body.includes('"audioPrompt"')) {
            return body;
          }
          return null;
        },
        { timeout: RESPONSE_WAIT_MS }
      );
      const responseText = await responseHandle.jsonValue();

      const plan = validatePlan(parsePlanJson(responseText));

      await fs.ensureDir(path.dirname(planPath));
      await fs.writeJson(planPath, plan, { spaces: 2 });

      return plan;
    } catch (err) {
      const msg = classifyStepError(STEP_NAME, err);
      throw new Error(msg);
    }
  }, 3, 2000);
}
