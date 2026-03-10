import dotenv from "dotenv";
import path from "node:path";
import fs from "fs-extra";
import { fileURLToPath } from "node:url";
import { mergeVideo } from "./steps/merge.js";

const __dir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config();
dotenv.config({ path: path.join(__dir, "../.env") });

async function main() {
  console.log("🎬 Orchestrating final merge...");
  
  try {
    await mergeVideo();
    
    const finalPath = path.resolve(process.cwd(), "./assets/final.mp4");
    if (await fs.pathExists(finalPath)) {
      const stat = await fs.stat(finalPath);
      console.log(`✅ Success! Final video created at: ${finalPath} (${stat.size} bytes)`);
    } else {
      console.error("❌ Final video was not found after merge step.");
    }
  } catch (err) {
    console.error("❌ Final merge failed:", err.message);
    process.exit(1);
  }
}

main();
