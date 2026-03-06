import { chromium } from "playwright";
import Browserbase from "@browserbasehq/sdk";
import path from "node:path";
import fs from "fs-extra";

const CONTEXT_CACHE_PATH = path.resolve(process.cwd(), ".browserbase-context.json");

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

export async function launchBrowser() {
  const { apiKey, projectId } = getBrowserbaseConfig();
  const timeoutRaw = process.env.BROWSERBASE_SESSION_TIMEOUT_SEC;
  const sessionTimeout = Number.isFinite(Number(timeoutRaw))
    ? Math.max(120, Number(timeoutRaw))
    : 30 * 60;
  const envContextId = process.env.BROWSERBASE_CONTEXT_ID?.trim() || null;
  const cachedContextId = await readCachedContextId();
  const contextId = envContextId || cachedContextId;

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
    browser = await chromium.connectOverCDP(connectUrl, connectOptions);
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
  } catch (_) {
    // Debug URL may not be available immediately
  }

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
