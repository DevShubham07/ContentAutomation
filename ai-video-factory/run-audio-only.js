import dotenv from "dotenv";
import path from "node:path";
import fs from "fs-extra";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "./utils/browser.js";
import { generateAudio } from "./steps/generateAudio.js";

const __dir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config();
dotenv.config({ path: path.join(__dir, "../.env") });

async function main() {
  const planPath = path.join(__dir, "assets/plan.json");
  if (!(await fs.pathExists(planPath))) {
    console.error("❌ plan.json not found in assets/");
    process.exit(1);
  }

  const plan = await fs.readJson(planPath);
  const text = plan.audioScript || "Hello, this is a test of the ElevenLabs audio generation system.";

  console.log("🔊 Generating audio for text:", text.slice(0, 50) + "...");

  try {
    const { browser, context } = await launchBrowser();
    
    // We use the connected browser context
    await generateAudio(context, text);

    console.log("✅ Audio generation complete!");
    await browser.close().catch(() => {});
  } catch (err) {
    console.error("❌ Audio generation failed:", err.message);
    process.exit(1);
  }
}

main();
