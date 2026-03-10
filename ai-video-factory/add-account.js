import { spawn } from "node:child_process";
import path from "node:path";
import fs from "fs-extra";
import { registerProfile } from "./utils/sessionManager.js";

async function addAccount() {
  const profileName = process.argv[2] && !process.argv[2].startsWith('--') 
    ? process.argv[2] 
    : "defaultProfile";

  console.log(`\n=== Setting up secure login for profile: ${profileName} ===\n`);
  
  // Register the profile in the manager
  await registerProfile(profileName);

  const dirName = profileName === "defaultProfile" ? ".local-browser-data" : `.local-browser-data-${profileName}`;
  const profileDir = path.resolve(process.cwd(), dirName);
  await fs.ensureDir(profileDir);

  // Find native Chrome
  const CHROME_PATHS = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Google\\Chrome Canary\\Application\\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  
  let executablePath = undefined;
  for (const p of CHROME_PATHS) {
    if (fs.existsSync(p)) {
      executablePath = p;
      break;
    }
  }

  if (!executablePath) {
    console.error("Chrome not found for local launch.");
    process.exit(1);
  }

  // Launch Chrome WITHOUT Playwright and WITHOUT Debugging Ports.
  // This bypasses Google's "Browser may not be secure" block.
  const chromeArgs = [
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "https://google.com",
    "https://elevenlabs.io"
  ];

  console.log("Launching completely native Chrome (no bots attached)...");
  console.log("1. Please log into Google Flow manually.");
  console.log("2. Then log into ElevenLabs.");
  console.log("3. Once you are successfully logged into both, CLOSE the Chrome window entirely.\n");

  const cp = spawn(executablePath, chromeArgs, {
    stdio: "inherit",
  });

  cp.on("close", (code) => {
    console.log(`Chrome window closed (exit code ${code}). Profile "${profileName}" cookies have been securely saved!`);
    console.log("You can now run the pipeline as normal.\n");
  });
}

addAccount().catch(console.error);
