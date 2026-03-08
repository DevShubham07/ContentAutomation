import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { chromium as vanillaChromium } from "playwright";
import Browserbase from "@browserbasehq/sdk";
import path from "node:path";
import fs from "fs-extra";

chromium.use(StealthPlugin());

const CONTEXT_CACHE_PATH = path.resolve(process.cwd(), ".browserbase-context.json");
const LOCAL_USER_DATA_DIR = path.resolve(process.cwd(), ".local-browser-data");
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function getBrowserbaseConfig() {
  const apiKey = process.env.BROWSERBASE_API_KEY || process.env.browser_token;
  const projectId = process.env.BROWSERBASE_PROJECT_ID || process.env.ProjectID;
  return {
    apiKey: typeof apiKey === "string" ? apiKey.trim() : "",
    projectId: typeof projectId === "string" ? projectId.trim() : "",
  };
}

async function readCachedContextId() {
  try {
    if (!(await fs.pathExists(CONTEXT_CACHE_PATH))) return null;
    const parsed = await fs.readJson(CONTEXT_CACHE_PATH);
    return typeof parsed?.contextId === "string" && parsed.contextId.trim()
      ? parsed.contextId.trim()
      : null;
  } catch {
    return null;
  }
}

async function writeCachedContextId(contextId) {
  if (!contextId || typeof contextId !== "string") return;
  await fs.writeJson(
    CONTEXT_CACHE_PATH,
    { contextId, updatedAt: new Date().toISOString() },
    { spaces: 2 }
  );
}

function shouldUseLocalBrowser() {
  const raw = process.env.USE_LOCAL_PLAYWRIGHT;
  if (typeof raw !== "string") return false;
  return TRUE_VALUES.has(raw.trim().toLowerCase());
}

async function launchLocalBrowser() {
  const headlessRaw = process.env.LOCAL_HEADLESS;
  const headless = typeof headlessRaw === "string" ? TRUE_VALUES.has(headlessRaw.trim().toLowerCase()) : false;
  const slowMoRaw = process.env.BROWSERBASE_SLOWMO ?? process.env.SLOWMO ?? process.env.LOCAL_SLOWMO;
  const slowMo = slowMoRaw != null ? Number(slowMoRaw) : undefined;

  await fs.ensureDir(LOCAL_USER_DATA_DIR);

  console.log("[Local Playwright] Launching stealth Chromium with persistent profile...");
  console.log(`[Local Playwright] User data dir: ${LOCAL_USER_DATA_DIR}`);

  const context = await chromium.launchPersistentContext(LOCAL_USER_DATA_DIR, {
    headless,
    ...(Number.isFinite(slowMo) && slowMo >= 0 ? { slowMo } : {}),
    acceptDownloads: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-infobars",
      "--window-size=1280,800",
    ],
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
    timezoneId: "America/New_York",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    ignoreDefaultArgs: ["--enable-automation"],
  });

  console.log("[Local Playwright] Browser launched successfully (stealth + persistent context).");

  return {
    browser: null,
    context,
    sessionId: null,
    replayUrl: null,
    liveUrl: null,
    contextId: null,
  };
}

export async function launchBrowser() {
  if (shouldUseLocalBrowser()) {
    return launchLocalBrowser();
  }

  const { apiKey, projectId } = getBrowserbaseConfig();
  const timeoutRaw = process.env.BROWSERBASE_SESSION_TIMEOUT_SEC;
  const sessionTimeout = Number.isFinite(Number(timeoutRaw))
    ? Math.max(120, Number(timeoutRaw))
    : 30 * 60;
  const envContextId = process.env.BROWSERBASE_CONTEXT_ID?.trim() || null;
  const cachedContextId = await readCachedContextId();
  let contextId = envContextId || cachedContextId;

  if (!apiKey || typeof apiKey !== "string" || apiKey.trim() === "") {
    throw new Error(
      "BROWSERBASE_API_KEY or browser_token is required and must be a non-empty string"
    );
  }

  if (!projectId || typeof projectId !== "string" || projectId.trim() === "") {
    throw new Error(
      "BROWSERBASE_PROJECT_ID or ProjectID is required and must be a non-empty string"
    );
  }

  const bb = new Browserbase({ apiKey });

  if (!contextId) {
    console.log("[Browserbase] No context ID found. Creating a new context for login persistence...");
    try {
      const ctx = await bb.contexts.create({ projectId: projectId.trim() });
      contextId = ctx?.id;
      if (contextId) {
        await writeCachedContextId(contextId);
        console.log("[Browserbase] New context created.");
      }
    } catch (err) {
      console.warn("[Browserbase] Could not create context:", err?.message || err);
    }
  }

  let session;
  try {
    session = await bb.sessions.create({
      projectId: projectId.trim(),
      keepAlive: true,
      timeout: sessionTimeout,
      ...(contextId
        ? { browserSettings: { context: { id: contextId, persist: true } } }
        : {}),
    });
  } catch (err) {
    const msg = err.message || String(err);
    console.error("Failed to create Browserbase session:", msg);
    const lower = msg.toLowerCase();
    if (lower.includes("max concurrent sessions limit") || lower.includes("burst rate limit") || lower.includes("429")) {
      console.warn("[Browserbase] Limits reached. Falling back to local stealth browser.");
      return launchLocalBrowser();
    }
    throw err;
  }

  const connectUrl = session.connectUrl;
  if (!connectUrl) {
    throw new Error("Browserbase session did not return a connectUrl");
  }

  const slowMoRaw = process.env.BROWSERBASE_SLOWMO ?? process.env.SLOWMO;
  const slowMo = slowMoRaw != null ? Number(slowMoRaw) : undefined;
  const connectOptions = {
    ...(Number.isFinite(slowMo) && slowMo >= 0 ? { slowMo } : {}),
    timeout: 60_000,
  };

  let browser;
  try {
    browser = await vanillaChromium.connectOverCDP(connectUrl, connectOptions);
  } catch (err) {
    const msg = err.message || String(err);
    if (msg.includes("timeout") || err.name === "TimeoutError") {
      throw new Error(`Browser connection timeout: ${msg}`);
    }
    console.error("Failed to connect to Browserbase:", msg);
    throw err;
  }

  let context;
  try {
    context = await browser.newContext({ acceptDownloads: true });
  } catch (err) {
    console.error("Failed to create browser context:", err.message);
    await browser.close().catch(() => {});
    throw err;
  }

  const sessionId = session.id;
  const replayUrl = `https://www.browserbase.com/sessions/${sessionId}`;
  let liveUrl = replayUrl;
  const resolvedContextId = session.contextId || contextId || null;

  if (resolvedContextId) {
    await writeCachedContextId(resolvedContextId);
  }

  console.log(`[Browserbase] Session ID: ${sessionId}`);
  if (resolvedContextId) {
    console.log(`[Browserbase] Context ID: ${resolvedContextId}`);
  }
  console.log(`[Browserbase] Replay (after session): ${replayUrl}`);

  try {
    const live = await bb.sessions.debug(sessionId);
    if (live?.debuggerFullscreenUrl) {
      liveUrl = live.debuggerFullscreenUrl;
      console.log(`[Browserbase] Live debugger: ${liveUrl}`);
    }
  } catch (_) {}

  return {
    browser,
    context,
    sessionId,
    replayUrl,
    liveUrl,
    contextId: resolvedContextId,
  };
}

export function closeBrowser() {}

export async function releaseBrowserbaseSession(sessionId) {
  if (!sessionId || typeof sessionId !== "string") return false;
  const { apiKey, projectId } = getBrowserbaseConfig();
  if (!apiKey) return false;

  try {
    const bb = new Browserbase({ apiKey });
    await bb.sessions.update(sessionId, {
      status: "REQUEST_RELEASE",
      ...(projectId ? { projectId } : {}),
    });
    return true;
  } catch {
    return false;
  }
}
