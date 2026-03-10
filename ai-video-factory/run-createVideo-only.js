import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "fs-extra";
const __dir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config();
dotenv.config({ path: path.join(__dir, "../.env") });

import { launchBrowser } from "./utils/browser.js";
import { createVideo } from "./steps/createVideo.js";
import { getAvailableProfile } from "./utils/sessionManager.js";

async function runCreateVideoOnly() {
  let browser;
  try {
    const currentProfile = await getAvailableProfile() || "account1";
    console.log(`Using profile: ${currentProfile}`);
    
    const result = await launchBrowser(currentProfile);
    browser = result.browser;
    const { context } = result;

    const plan = await fs.readJson("./assets/plan.json");
    if (!plan.videoPrompts || plan.videoPrompts.length === 0) {
        console.log("No video prompts found in plan.json");
        return;
    }

    console.log("Running createVideo with videoPrompts:", plan.videoPrompts);
    await createVideo(context, plan.videoPrompts);
    console.log("createVideo finished successfully.");

  } catch (err) {
    console.error("Error running createVideo only:", err);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

runCreateVideoOnly();
