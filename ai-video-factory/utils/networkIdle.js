/**
 * Wait for network idle (no requests for 500ms) or timeout.
 * Does not throw on timeout - continues when time expires.
 */
export async function waitForNetworkIdle(page, timeoutMs = 15_000) {
  try {
    await page.waitForLoadState("networkidle", { timeout: timeoutMs });
  } catch {
    // Timeout is acceptable - page may have ongoing analytics
  }
}
