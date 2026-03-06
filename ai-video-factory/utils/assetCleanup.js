import path from "node:path";
import fs from "fs-extra";

const ASSETS_DIR = "./assets";
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function cleanOldAssets() {
  const assetsPath = path.resolve(process.cwd(), ASSETS_DIR);
  if (!(await fs.pathExists(assetsPath))) return;

  const now = Date.now();
  let removed = 0;

  const dirs = ["frames", "video", "audio"];
  for (const dir of dirs) {
    const dirPath = path.join(assetsPath, dir);
    if (!(await fs.pathExists(dirPath))) continue;

    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const ent of entries) {
      const fullPath = path.join(dirPath, ent.name);
      try {
        const stat = await fs.stat(fullPath);
        if (now - stat.mtimeMs > MAX_AGE_MS) {
          await fs.remove(fullPath);
          removed += 1;
        }
      } catch (_) {}
    }
  }

  const finalPath = path.join(assetsPath, "final.mp4");
  if (await fs.pathExists(finalPath)) {
    try {
      const stat = await fs.stat(finalPath);
      if (now - stat.mtimeMs > MAX_AGE_MS) {
        await fs.remove(finalPath);
        removed += 1;
      }
    } catch (_) {}
  }

  return removed;
}

export function startAssetCleanupInterval(intervalMs = 60 * 60 * 1000) {
  const id = setInterval(() => {
    cleanOldAssets().catch((err) => {
      console.error("Asset cleanup error:", err.message);
    });
  }, intervalMs);
  return () => clearInterval(id);
}
