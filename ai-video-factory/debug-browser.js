import { chromium } from "playwright";

async function check() {
  const cdpUrl = "http://127.0.0.1:9222";
  console.log(`Connecting to ${cdpUrl}...`);
  try {
    const browser = await chromium.connectOverCDP(cdpUrl);
    console.log("Connected successfully!");
    const contexts = browser.contexts();
    console.log(`Number of contexts: ${contexts.length}`);
    for (const ctx of contexts) {
        const pages = ctx.pages();
        console.log(`- Context pages: ${pages.length}`);
        for (const p of pages) {
            console.log(`  - ${p.url()}`);
        }
    }
    await browser.close();
  } catch (err) {
    console.error("Failed to connect:", err.message);
  }
}

check();
