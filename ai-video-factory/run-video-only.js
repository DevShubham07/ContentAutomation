/**
 * run-video-only.js
 * Runs only the createVideo step using already-generated frames.
 * Usage: node run-video-only.js
 */
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config();
dotenv.config({ path: path.join(__dir, "../.env") });

import { launchBrowser } from "./utils/browser.js";
import { createVideo } from "./steps/createVideo.js";
import fs from "fs-extra";

async function run() {
  const planPath = path.resolve(process.cwd(), "./assets/plan.json");
  const plan = await fs.readJson(planPath);
  const videoPrompts = plan.videoPrompts || ["Smooth cinematic transition between the two frames"];

  const result = await launchBrowser();
  const { browser, context } = result;

  try {
    await createVideo(context, videoPrompts);
    console.log("✅ Video creation complete!");
  } finally {
    await browser.close().catch(() => {});
  }
}

run().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
