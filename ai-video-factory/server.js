import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirnameForEnv = path.dirname(fileURLToPath(import.meta.url));
dotenv.config();
dotenv.config({ path: path.join(__dirnameForEnv, "../.env") });

import express from "express";
import { WebSocketServer } from "ws";
import { createJob, getJob, updateJob, jobs } from "./jobs.js";
import { createJobRoutes } from "./routes/jobRoutes.js";
import { setPipelineRunner, setBroadcast, drain } from "./queue/jobQueue.js";
import { runPipeline } from "./pipeline/runPipeline.js";
import { startAssetCleanupInterval } from "./utils/assetCleanup.js";

const __dirname = __dirnameForEnv;
const PORT = 4000;

const wss = new WebSocketServer({ noServer: true });

function broadcastJobUpdate(jobId, stage, message, data = {}) {
  const payload = JSON.stringify({ jobId, stage, message, data });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(payload);
    }
  });
}

setPipelineRunner(runPipeline);
setBroadcast(broadcastJobUpdate);

const stopAssetCleanup = startAssetCleanupInterval(60 * 60 * 1000);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/assets", express.static(path.join(__dirname, "assets")));
app.use(createJobRoutes(broadcastJobUpdate));

const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

server.on("upgrade", (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

let isShuttingDown = false;

function gracefulShutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log("\nShutting down gracefully...");

  stopAssetCleanup();

  server.close(() => {
    console.log("HTTP server closed");
  });

  wss.clients.forEach((client) => {
    client.close();
  });

  drain()
    .then(() => {
      console.log("All jobs finished");
      process.exit(0);
    })
    .catch(() => {
      process.exit(1);
    });

  setTimeout(() => {
    console.error("Shutdown timeout - forcing exit");
    process.exit(1);
  }, 30_000);
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

export { jobs, createJob, getJob, updateJob, broadcastJobUpdate };
