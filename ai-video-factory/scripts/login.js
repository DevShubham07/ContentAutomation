#!/usr/bin/env node
/**
 * Manual Login Helper
 *
 * Launches your REAL Chrome browser directly (NOT through Playwright) with the
 * same user-data-dir used by the pipeline. Because Chrome runs natively with
 * NO automation flags, Google OAuth sign-in works perfectly.
 *
 * Usage:  node scripts/login.js
 * Or:     npm run login
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, spawn } from "node:child_process";
import readline from "node:readline";
import fs from "fs-extra";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_USER_DATA_DIR = path.resolve(__dirname, "../.local-browser-data");

// All services used by the pipeline
const SITES = [
    "https://accounts.google.com",
    "https://chatgpt.com",
    "https://labs.google/fx/flow",
    "https://elevenlabs.io/app/speech-synthesis",
];

// Find Chrome on macOS
const CHROME_PATHS = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Google\\Chrome Canary\\Application\\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

function findChrome() {
    for (const p of CHROME_PATHS) {
        try {
            fs.accessSync(p, fs.constants.X_OK);
            return p;
        } catch { }
    }
    return null;
}

function waitForEnter(prompt) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(prompt, () => {
            rl.close();
            resolve();
        });
    });
}

async function main() {
    await fs.ensureDir(LOCAL_USER_DATA_DIR);

    // Clean lock files
    for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
        await fs.remove(path.join(LOCAL_USER_DATA_DIR, f)).catch(() => { });
    }

    const chromePath = findChrome();
    if (!chromePath) {
        console.error("❌ Google Chrome not found. Install it from https://google.com/chrome");
        process.exit(1);
    }

    console.log("\n🔐 Login Helper — Opening your REAL Chrome (zero automation flags)\n");
    console.log(`   Chrome: ${chromePath}`);
    console.log(`   Profile: ${LOCAL_USER_DATA_DIR}\n`);
    console.log("   👉 Step 1: Sign into Google FIRST in the Google Accounts tab");
    console.log("   👉 Step 2: Then sign into ChatGPT, Google Flow, ElevenLabs");
    console.log("   👉 Step 3: Come back here and press ENTER to save sessions\n");

    // Launch Chrome directly — NO Playwright, NO automation flags
    const chromeArgs = [
        `--user-data-dir=${LOCAL_USER_DATA_DIR}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--remote-debugging-port=9222",
        ...SITES,
    ];

    const chrome = spawn(chromePath, chromeArgs, {
        detached: true,
        stdio: "ignore",
    });
    chrome.unref();

    console.log(`   ✅ Chrome launched with ${SITES.length} tabs. Log into each site now.\n`);
    console.log("   This is your REAL Chrome with NO automation detection.");
    console.log("   Google sign-in will work normally.\n");

    await waitForEnter("   Press ENTER here when you've logged into all sites... ");

    console.log("\n   ✅ Sessions are saved. Leaving Chrome running in the background.");
    console.log("   ✅ Done! Run the pipeline with: npm start\n");
}

main().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
});
