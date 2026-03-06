export async function retry(fn, attempts = 3, delayMs = 2000) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        const waitTime = delayMs * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }
  }
  throw lastError;
}
