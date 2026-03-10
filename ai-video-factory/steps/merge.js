import path from "node:path";
import fs from "fs-extra";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const STEP_NAME = "mergeVideo";
const VIDEO_PATH = "./assets/video/output.mp4";
const AUDIO_PATH = "./assets/audio/narration.mp3";
const OUTPUT_PATH = "./assets/final.mp4";

export async function mergeVideo(logger) {
  const log = (msg) => {
    if (logger) logger.log(msg);
    else console.log(`[${STEP_NAME}] ${msg}`);
  };
  const videoPath = path.resolve(process.cwd(), VIDEO_PATH);
  const audioPath = path.resolve(process.cwd(), AUDIO_PATH);
  const outputPath = path.resolve(process.cwd(), OUTPUT_PATH);

  if (!(await fs.pathExists(videoPath))) {
    throw new Error(`[${STEP_NAME}] Video file not found: ${VIDEO_PATH}`);
  }
  if (!(await fs.pathExists(audioPath))) {
    throw new Error(`[${STEP_NAME}] Audio file not found: ${AUDIO_PATH}`);
  }

  const cmd = `ffmpeg -y -i "${videoPath}" -i "${audioPath}" -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -shortest "${outputPath}"`;

  try {
    await execAsync(cmd, { timeout: 120_000 });
  } catch (err) {
    const msg = err.stderr ? err.stderr.slice(-1000) : err.message;
    throw new Error(`[${STEP_NAME}] ffmpeg failed: ${msg}`);
  }
}
