export function classifyStepError(stepName, err) {
  const msg = err?.message || String(err);
  const lower = msg.toLowerCase();

  if (
    lower.includes("login") ||
    lower.includes("sign in") ||
    lower.includes("sign-in") ||
    lower.includes("auth") ||
    lower.includes("prompt-textarea") ||
    lower.includes("text input")
  ) {
    return `[${stepName}] LOGIN_REQUIRED: ${msg}`;
  }

  if (
    lower.includes("timeout") ||
    lower.includes("net::") ||
    lower.includes("selector") ||
    lower.includes("target page, context or browser has been closed") ||
    lower.includes("human verification") ||
    lower.includes("cloudflare")
  ) {
    return `[${stepName}] TEMPORARY_SITE_ISSUE: ${msg}`;
  }

  return `[${stepName}] ${msg}`;
}

export async function inferLoginRequired(page) {
  try {
    const url = page.url()?.toLowerCase() || "";
    if (
      url.includes("login") ||
      url.includes("signin") ||
      url.includes("sign-in") ||
      url.includes("auth")
    ) {
      return true;
    }

    const bodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
    return (
      bodyText.includes("log in") ||
      bodyText.includes("login") ||
      bodyText.includes("sign in") ||
      bodyText.includes("continue with")
    );
  } catch {
    return false;
  }
}
