#!/usr/bin/env node
/**
 * Browserbase Login Helper
 *
 * Creates a Browserbase session and opens the live view URL in your regular
 * browser so you can log into Google/Gemini. The session uses a persistent
 * context so your login is saved for future pipeline runs.
 *
 * Usage:  node scripts/login-bb.js
 * Or:     npm run login:bb
 */
import { chromium } from "playwright";
import Browserbase from "@browserbasehq/sdk";
import { exec } from "node:child_process";
import readline from "node:readline";
import dotenv from "dotenv";
dotenv.config();

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
    const apiKey = (process.env.BROWSERBASE_API_KEY || process.env.browser_token || "").trim();
    const projectId = (process.env.BROWSERBASE_PROJECT_ID || process.env.ProjectID || "").trim();
    const contextId = (process.env.BROWSERBASE_CONTEXT_ID || "").trim() || null;

    if (!apiKey) { console.error("❌ Set BROWSERBASE_API_KEY / browser_token in .env"); process.exit(1); }
    if (!projectId) { console.error("❌ Set BROWSERBASE_PROJECT_ID / ProjectID in .env"); process.exit(1); }

    const bb = new Browserbase({ apiKey });

    console.log("\n🔐 Browserbase Login Helper\n");
    console.log("   Creating a cloud browser session...");

    const session = await bb.sessions.create({
        projectId,
        keepAlive: true,
        timeout: 15 * 60,
        ...(contextId
            ? { browserSettings: { context: { id: contextId, persist: true } } }
            : {}),
    });

    console.log(`   Session ID: ${session.id}`);
    if (contextId) console.log(`   Context ID: ${contextId} (login will be saved)`);

    // Get the live view URL
    const live = await bb.sessions.debug(session.id);
    const liveUrl = live?.debuggerFullscreenUrl || `https://www.browserbase.com/sessions/${session.id}`;

    console.log(`\n   🌐 Opening live view in your browser...\n`);

    // Connect to the session and navigate to Gemini
    const browser = await chromium.connectOverCDP(session.connectUrl, { timeout: 60_000 });
    const context = browser.contexts()[0] || await browser.newContext();
    const page = await context.newPage();
    await page.goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded", timeout: 60_000 });

    // Open the live view URL in the user's real browser
    exec(`open "${liveUrl}"`);

    console.log(`   Live URL: ${liveUrl}\n`);
    console.log("   👉 A browser tab opened showing the Browserbase session.");
    console.log("   👉 Log into Google/Gemini in that tab.");
    console.log("   👉 Your login will be saved to the Browserbase context.\n");

    await waitForEnter("   Press ENTER here when you've logged in... ");

    console.log("\n   Closing session...");
    await browser.close();

    try {
        await bb.sessions.update(session.id, { status: "REQUEST_RELEASE" });
    } catch { }

    console.log("   ✅ Done! Login saved. The pipeline will use this session.\n");
}

main().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
});
