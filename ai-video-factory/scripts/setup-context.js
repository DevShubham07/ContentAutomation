#!/usr/bin/env node
/**
 * Creates a Browserbase context for persisting ChatGPT login across sessions.
 * Run once, then add BROWSERBASE_CONTEXT_ID to your .env file.
 *
 * Usage: node scripts/setup-context.js
 * Or: npm run setup:context
 */
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "fs-extra";
import Browserbase from "@browserbasehq/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../..");
const envPath = path.join(rootDir, ".env");

dotenv.config();
dotenv.config({ path: envPath });

const apiKey = process.env.BROWSERBASE_API_KEY || process.env.browser_token;
const projectId = process.env.BROWSERBASE_PROJECT_ID || process.env.ProjectID;

if (!apiKey?.trim()) {
  console.error("Error: BROWSERBASE_API_KEY or browser_token is required in .env");
  process.exit(1);
}

if (!projectId?.trim()) {
  console.error("Error: BROWSERBASE_PROJECT_ID or ProjectID is required in .env");
  process.exit(1);
}

const bb = new Browserbase({ apiKey });

async function main() {
  const ctx = await bb.contexts.create({ projectId: projectId.trim() });
  const contextId = ctx?.id;

  if (!contextId) {
    console.error("Error: Failed to create context");
    process.exit(1);
  }

  console.log("\nBrowserbase context created successfully!\n");
  console.log("Add this to your .env file:\n");
  console.log(`BROWSERBASE_CONTEXT_ID=${contextId}\n`);
  console.log("Then run the pipeline. On the first run:");
  console.log("  1. The Live View will open in your browser");
  console.log("  2. Log into ChatGPT when prompted");
  console.log("  3. Future runs will reuse your session automatically\n");

  const envContent = await fs.readFile(envPath, "utf-8").catch(() => "");
  if (envContent && !envContent.includes("BROWSERBASE_CONTEXT_ID")) {
    const line = `BROWSERBASE_CONTEXT_ID=${contextId}`;
    await fs.appendFile(envPath, `\n${line}\n`);
    console.log(`Added BROWSERBASE_CONTEXT_ID to ${path.relative(process.cwd(), envPath)}\n`);
  }
}

main().catch((err) => {
  console.error("Error:", err?.message || err);
  process.exit(1);
});
