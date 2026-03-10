#!/usr/bin/env node
/**
 * Debug script for ElevenLabs — connects to running Chrome,
 * navigates to ElevenLabs Speech Synthesis, and scans all UI elements.
 */
import path from "node:path";
import fs from "fs-extra";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = path.resolve(__dirname, "../assets/debug-screenshots");
const ELEVENLABS_URL = "https://elevenlabs.io/app/speech-synthesis";

let idx = 0;
async function screenshot(page, label) {
    idx++;
    const filename = `eleven_${String(idx).padStart(2, "0")}_${label}.png`;
    const filepath = path.join(SCREENSHOTS_DIR, filename);
    await page.screenshot({ path: filepath });
    console.log(`📸 ${filename}`);
}

async function scanPage(page, label) {
    console.log(`\n══════════ ${label} ══════════`);

    // Buttons
    console.log("\n── BUTTONS ──");
    const buttons = page.locator("button");
    const btnCount = await buttons.count();
    for (let i = 0; i < Math.min(btnCount, 40); i++) {
        const btn = buttons.nth(i);
        try {
            const visible = await btn.isVisible().catch(() => false);
            if (!visible) continue;
            const text = await btn.innerText().catch(() => "");
            const ariaLabel = await btn.getAttribute("aria-label").catch(() => "");
            const dataTestId = await btn.getAttribute("data-testid").catch(() => "");
            console.log(`  BTN#${i}: text="${text.slice(0, 80).replace(/\n/g, " ")}" | aria="${ariaLabel || ""}" | testid="${dataTestId || ""}"`);
        } catch { }
    }

    // Textareas and inputs
    console.log("\n── INPUTS ──");
    const inputs = page.locator("input, textarea, [contenteditable='true'], [role='textbox']");
    const inputCount = await inputs.count();
    for (let i = 0; i < Math.min(inputCount, 15); i++) {
        const inp = inputs.nth(i);
        try {
            const visible = await inp.isVisible().catch(() => false);
            if (!visible) continue;
            const tag = await inp.evaluate((el) => el.tagName).catch(() => "?");
            const type = await inp.getAttribute("type").catch(() => "");
            const placeholder = await inp.getAttribute("placeholder").catch(() => "");
            const ariaLabel = await inp.getAttribute("aria-label").catch(() => "");
            const role = await inp.getAttribute("role").catch(() => "");
            const dataTestId = await inp.getAttribute("data-testid").catch(() => "");
            const className = await inp.getAttribute("class").catch(() => "");
            console.log(`  INPUT#${i}: <${tag}> type="${type || ""}" placeholder="${placeholder || ""}" aria="${ariaLabel || ""}" role="${role || ""}" testid="${dataTestId || ""}" class="${(className || "").slice(0, 60)}"`);
        } catch { }
    }

    // Audio/media elements
    console.log("\n── AUDIO/MEDIA ──");
    const audioEls = page.locator("audio, video, [role='slider']");
    const audioCount = await audioEls.count();
    for (let i = 0; i < Math.min(audioCount, 10); i++) {
        const el = audioEls.nth(i);
        try {
            const visible = await el.isVisible().catch(() => false);
            if (!visible) continue;
            const tag = await el.evaluate((e) => e.tagName).catch(() => "?");
            const src = await el.getAttribute("src").catch(() => "");
            console.log(`  MEDIA#${i}: <${tag}> src="${(src || "").slice(0, 80)}"`);
        } catch { }
    }

    // Text markers
    console.log("\n── TEXT MARKERS ──");
    const markers = [
        "Generate", "Convert", "Download", "Play", "Pause",
        "Speech Synthesis", "Text to Speech", "Voice",
        "Settings", "Model", "Stability", "Style",
    ];
    for (const m of markers) {
        try {
            const el = page.locator(`text="${m}"`).first();
            const visible = await el.isVisible({ timeout: 500 }).catch(() => false);
            if (visible) {
                const tag = await el.evaluate((e) => e.tagName).catch(() => "?");
                console.log(`  ✅ Found "${m}" in <${tag}>`);
            }
        } catch { }
    }

    // Select/dropdown elements
    console.log("\n── DROPDOWNS ──");
    const dropdowns = page.locator("select, [role='listbox'], [role='combobox'], [role='menu']");
    const ddCount = await dropdowns.count();
    for (let i = 0; i < Math.min(ddCount, 10); i++) {
        const dd = dropdowns.nth(i);
        try {
            const visible = await dd.isVisible().catch(() => false);
            if (!visible) continue;
            const text = await dd.innerText().catch(() => "");
            const role = await dd.getAttribute("role").catch(() => "");
            console.log(`  DD#${i}: role="${role}" text="${text.slice(0, 60).replace(/\n/g, " ")}"`);
        } catch { }
    }
}

async function main() {
    await fs.ensureDir(SCREENSHOTS_DIR);

    console.log("🔌 Connecting to Chrome on port 9222...");
    const browser = await chromium.connectOverCDP("http://localhost:9222", { timeout: 15_000 });
    const context = browser.contexts()[0];
    if (!context) {
        console.error("❌ No browser context found.");
        process.exit(1);
    }

    let page = context.pages().find((p) => p.url().includes("elevenlabs.io"));
    if (!page) {
        page = await context.newPage();
    }

    console.log(`📎 Navigating to ${ELEVENLABS_URL}...`);
    await page.goto(ELEVENLABS_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await new Promise((r) => setTimeout(r, 5000));

    console.log(`📄 URL: ${page.url()}`);
    console.log(`📄 Title: ${await page.title()}`);

    await screenshot(page, "initial");
    await scanPage(page, "ELEVENLABS SPEECH SYNTHESIS");
    await screenshot(page, "after_scan");

    console.log(`\n✅ Done! Screenshots in: ${SCREENSHOTS_DIR}\n`);
    await browser.close();
}

main().catch((err) => {
    console.error("❌ Error:", err.message);
    process.exit(1);
});
