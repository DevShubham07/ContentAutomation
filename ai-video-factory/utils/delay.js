/**
 * Random human-like delay between min and max milliseconds.
 * Use between interactions to mimic natural user behavior.
 */
export function humanDelay(minMs = 300, maxMs = 1200) {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return new Promise((resolve) => setTimeout(resolve, ms));
}
