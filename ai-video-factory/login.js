import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config();
dotenv.config({ path: path.join(__dir, "../.env") });

import { launchBrowser } from "./utils/browser.js";

async function login() {
  const { browser, context, liveUrl } = await launchBrowser();
  console.log("\n=======================================================");
  console.log("ACTION REQUIRED: Manual Login Setup");
  console.log("=======================================================");
  console.log(`Please open the Live Debugger URL below in your browser:`);
  console.log(`\n${liveUrl}\n`);
  console.log("In the debugger, please log into the following services:");
  console.log("1. ChatGPT (https://chatgpt.com)");
  console.log("2. Grok (https://grok.com)");
  console.log("3. ElevenLabs (https://elevenlabs.io)");
  console.log("4. Google Flow (https://labs.google/fx/flow)");
  console.log("\nThe session will stay open for 15 minutes. Once you are logged in to all of them, let me know.");
  
  const page1 = await context.newPage(); await page1.goto("https://chatgpt.com");
  const page2 = await context.newPage(); await page2.goto("https://grok.com");
  const page3 = await context.newPage(); await page3.goto("https://elevenlabs.io");
  const page4 = await context.newPage(); await page4.goto("https://labs.google/fx/flow");
  
  await new Promise(r => setTimeout(r, 60 * 15 * 1000));
  console.log("Time is up. Closing browser.");
  await browser.close().catch(() => {});
}

login().catch(console.error);
