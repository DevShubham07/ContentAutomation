import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config();
dotenv.config({ path: path.join(__dir, "../.env") });
import { launchBrowser } from "./utils/browser.js";
import { humanDelay } from "./utils/delay.js";
import { generatePlan } from "./steps/generatePlan.js";
import { generateImages } from "./steps/generateImages.js";
import { createVideo } from "./steps/createVideo.js";
import { generateAudio } from "./steps/generateAudio.js";
import { mergeVideo } from "./steps/merge.js";

async function run(theme) {
  let browser;
  let grokContext;
  let flowContext;
  let elevenContext;

  const cleanup = async () => {
    const close = async (obj) => {
      if (obj) await obj.close().catch(() => {});
    };
    await close(grokContext);
    await close(flowContext);
    await close(elevenContext);
    await close(browser);
  };

  const handleSigint = () => {
    process.off("SIGINT", handleSigint);
    console.error("\nInterrupted. Closing browser...");
    cleanup().then(() => process.exit(130));
  };
  process.on("SIGINT", handleSigint);

  try {
    const result = await launchBrowser();
    browser = result.browser;
    const { context } = result;

    const gptPage = await context.newPage();
    grokContext = await browser.newContext({ acceptDownloads: true });
    flowContext = await browser.newContext({ acceptDownloads: true });
    elevenContext = await browser.newContext({ acceptDownloads: true });

    let plan;
    try {
      plan = await generatePlan(gptPage, theme);
    } catch (err) {
      throw new Error(`Step "generatePlan" failed: ${err.message}`);
    }
    await humanDelay(1000, 2500);

    try {
      await generateImages(grokContext, plan.framePrompts);
    } catch (err) {
      throw new Error(`Step "generateImages" failed: ${err.message}`);
    }
    await humanDelay(1000, 2500);

    try {
      await createVideo(flowContext);
    } catch (err) {
      throw new Error(`Step "createVideo" failed: ${err.message}`);
    }
    await humanDelay(1000, 2500);

    try {
      await generateAudio(elevenContext, plan.audioPrompt);
    } catch (err) {
      throw new Error(`Step "generateAudio" failed: ${err.message}`);
    }
    await humanDelay(500, 1200);

    try {
      await mergeVideo();
    } catch (err) {
      throw new Error(`Step "mergeVideo" failed: ${err.message}`);
    }

    process.off("SIGINT", handleSigint);
    await cleanup();
  } catch (err) {
    process.off("SIGINT", handleSigint);
    await cleanup();
    throw err;
  }
}

const theme = process.argv.slice(2).join(" ").trim();
if (!theme) {
  console.error("Error: Theme is required. Usage: node index.js \"theme here\"");
  process.exit(1);
}

run(theme).catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
