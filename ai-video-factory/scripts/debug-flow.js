#!/usr/bin/env node
/**
 * Debug script for Google Flow — Phase 2
 * Clicks "New project" and scans the project creation UI.
 */
import path from "node:path";
import fs from "fs-extra";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = path.resolve(__dirname, "../assets/debug-screenshots");
const FLOW_URL = "https://labs.google/fx/flow";

let screenshotIndex = 0;

async function screenshot(page, label) {
    screenshotIndex++;
    const filename = `${String(screenshotIndex).padStart(2, "0")}_${label}.png`;
    const filepath = path.join(SCREENSHOTS_DIR, filename);
    await page.screenshot({ path: filepath });
    console.log(`📸 ${filename}`);
    return filepath;
}

async function scanAllVisibleElements(page, label) {
    console.log(`\n══════════════════ ${label} ══════════════════`);

    // Buttons
    console.log("\n── BUTTONS ──");
    const buttons = page.locator("button");
    const buttonCount = await buttons.count();
    for (let i = 0; i < Math.min(buttonCount, 40); i++) {
        const btn = buttons.nth(i);
        try {
            const visible = await btn.isVisible().catch(() => false);
            if (!visible) continue;
            const text = await btn.innerText().catch(() => "");
            const ariaLabel = await btn.getAttribute("aria-label").catch(() => "");
            const className = await btn.getAttribute("class").catch(() => "");
            console.log(`  BTN#${i}: text="${text.slice(0, 60).replace(/\n/g, " ")}" | aria="${ariaLabel || ""}" | class="${(className || "").slice(0, 80)}"`);
        } catch { }
    }

    // Inputs, textareas, contenteditable
    console.log("\n── INPUTS ──");
    const inputs = page.locator("input, textarea, [contenteditable='true']");
    const inputCount = await inputs.count();
    for (let i = 0; i < Math.min(inputCount, 15); i++) {
        const inp = inputs.nth(i);
        try {
            const visible = await inp.isVisible().catch(() => false);
            if (!visible) continue;
            const type = await inp.getAttribute("type").catch(() => "");
            const placeholder = await inp.getAttribute("placeholder").catch(() => "");
            const ariaLabel = await inp.getAttribute("aria-label").catch(() => "");
            const tagName = await inp.evaluate((el) => el.tagName).catch(() => "");
            console.log(`  INPUT#${i}: tag=${tagName} | type="${type || ""}" | placeholder="${placeholder || ""}" | aria="${ariaLabel || ""}"`);
        } catch { }
    }

    // Dropdowns / selects / tabs / menus
    console.log("\n── INTERACTIVE ELEMENTS ──");
    const interactiveSelectors = [
        "[role='tab']", "[role='tablist']", "[role='listbox']", "[role='combobox']",
        "[role='menu']", "[role='menuitem']", "[role='option']", "[role='radio']",
        "[role='radiogroup']", "[role='switch']", "[role='slider']",
        "select", "[data-testid]",
    ];
    for (const sel of interactiveSelectors) {
        const els = page.locator(sel);
        const count = await els.count();
        for (let i = 0; i < Math.min(count, 10); i++) {
            const el = els.nth(i);
            try {
                const visible = await el.isVisible().catch(() => false);
                if (!visible) continue;
                const text = await el.innerText().catch(() => "");
                const ariaLabel = await el.getAttribute("aria-label").catch(() => "");
                const role = await el.getAttribute("role").catch(() => "");
                console.log(`  ${sel}#${i}: role="${role}" | text="${text.slice(0, 60).replace(/\n/g, " ")}" | aria="${ariaLabel || ""}"`);
            } catch { }
        }
    }

    // Divs with specific text
    console.log("\n── TEXT MARKERS ──");
    const textMarkers = [
        "Text to Video", "Frames to Video", "Ingredients to video",
        "Portrait", "Landscape", "Square", "9:16", "16:9", "1:1",
        "Start frame", "End frame", "Prompt", "Generate", "Create",
        "Add", "Upload", "frames", "Frames",
    ];
    for (const marker of textMarkers) {
        try {
            const el = page.locator(`text="${marker}"`).first();
            const visible = await el.isVisible({ timeout: 500 }).catch(() => false);
            if (visible) {
                const tagName = await el.evaluate((e) => e.tagName).catch(() => "?");
                console.log(`  ✅ Found "${marker}" in <${tagName}>`);
            }
        } catch { }
    }
}

async function main() {
    await fs.ensureDir(SCREENSHOTS_DIR);
    await fs.emptyDir(SCREENSHOTS_DIR);

    console.log("🔌 Connecting to Chrome on port 9222...");
    const browser = await chromium.connectOverCDP("http://localhost:9222", { timeout: 15_000 });
    const context = browser.contexts()[0];

    if (!context) {
        console.error("❌ No browser context found.");
        process.exit(1);
    }

    let page = context.pages().find((p) => p.url().includes("labs.google"));
    if (!page) {
        page = await context.newPage();
    }

    // ── Navigate to Flow ──
    console.log(`\n📎 Navigating to ${FLOW_URL}...`);
    await page.goto(FLOW_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await new Promise((r) => setTimeout(r, 5000));
    await screenshot(page, "01_landing");

    // ── Dismiss the banner if present ──
    console.log("\n🔄 Dismissing banner...");
    try {
        const closeBtn = page.locator("button:has-text('close')").first();
        if (await closeBtn.isVisible({ timeout: 3000 })) {
            await closeBtn.click();
            await new Promise((r) => setTimeout(r, 1000));
            console.log("  ✅ Banner dismissed.");
        }
    } catch { }
    await screenshot(page, "02_after_banner_dismiss");

    await scanAllVisibleElements(page, "LANDING PAGE");

    // ── Click "New project" ──
    console.log("\n\n🆕 Clicking 'New project'...");
    try {
        const newProjBtn = page.locator("button:has-text('New project')").first();
        await newProjBtn.waitFor({ state: "visible", timeout: 10_000 });
        await newProjBtn.click();
        await new Promise((r) => setTimeout(r, 5000));
        console.log("  ✅ Clicked 'New project'.");
    } catch (err) {
        console.error("  ❌ Failed to click 'New project':", err.message);
    }
    await screenshot(page, "03_after_new_project");

    // Log the URL — might have changed to /project/{id}
    console.log(`\n📄 Current URL: ${page.url()}`);

    await scanAllVisibleElements(page, "INSIDE NEW PROJECT");
    await screenshot(page, "04_project_view_full");

    // ── Scroll down to see more ──
    await page.evaluate(() => window.scrollBy(0, 500));
    await new Promise((r) => setTimeout(r, 2000));
    await screenshot(page, "05_scrolled_down");

    console.log(`\n✅ Debug Phase 2 complete! Screenshots saved to: ${SCREENSHOTS_DIR}\n`);
    await browser.close();
}

main().catch((err) => {
    console.error("❌ Error:", err.message);
    process.exit(1);
});
