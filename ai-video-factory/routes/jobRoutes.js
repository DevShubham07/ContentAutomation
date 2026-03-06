import express from "express";
import {
  createJob,
  getJob,
  requestPause,
  clearPauseRequest,
  requestAbort,
  clearAbortRequest,
  updateJob,
} from "../jobs.js";
import { enqueue, enqueueResume, dequeueJob, isJobActive } from "../queue/jobQueue.js";

export function createJobRoutes(broadcastJobUpdate) {
  const router = express.Router();

  router.post("/create-job", (req, res) => {
    const theme = req.body?.theme;

    if (typeof theme !== "string" || !theme.trim()) {
      return res.status(400).json({ error: "theme is required and must be a non-empty string" });
    }

    const job = createJob(theme.trim());
    broadcastJobUpdate(job.id, "created", "Job created", { job });

    res.status(201).json({ jobId: job.id });

    enqueue(job.id, theme.trim());
  });

  router.get("/jobs/:id", (req, res) => {
    const job = getJob(req.params.id);
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }
    res.json(job);
  });

  router.post("/jobs/:id/pause", (req, res) => {
    const { id } = req.params;
    const job = getJob(id);
    if (!job) return res.status(404).json({ error: "Job not found" });

    requestPause(id);
    if (job.status === "pending") {
      updateJob(id, {
        status: "paused",
        actionRequired: "Paused before execution by operator request",
      });
      dequeueJob(id);
    }
    broadcastJobUpdate(id, "paused", "Pause requested", { job: getJob(id) });
    res.json({ ok: true, job: getJob(id) });
  });

  router.post("/jobs/:id/resume", async (req, res) => {
    const { id } = req.params;
    const job = getJob(id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (isJobActive(id)) {
      return res.status(409).json({ error: "Job is already queued or running" });
    }

    clearPauseRequest(id);
    clearAbortRequest(id);
    updateJob(id, {
      status: "pending",
      actionRequired: null,
      lastError: null,
    });
    await enqueueResume(id);
    broadcastJobUpdate(id, "resumed", "Job resumed", { job: getJob(id) });
    res.json({ ok: true, job: getJob(id) });
  });

  router.post("/jobs/:id/retry-step", async (req, res) => {
    const { id } = req.params;
    const job = getJob(id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (isJobActive(id)) {
      return res.status(409).json({ error: "Job is already queued or running" });
    }

    clearPauseRequest(id);
    clearAbortRequest(id);
    updateJob(id, {
      status: "pending",
      actionRequired: null,
      lastError: null,
      attempt: 0,
    });
    await enqueueResume(id);
    broadcastJobUpdate(id, "retrying", "Retrying current step", { job: getJob(id) });
    res.json({ ok: true, job: getJob(id) });
  });

  router.post("/jobs/:id/abort", (req, res) => {
    const { id } = req.params;
    const job = getJob(id);
    if (!job) return res.status(404).json({ error: "Job not found" });

    requestAbort(id);
    dequeueJob(id);
    if (job.status === "pending" || job.status === "paused") {
      updateJob(id, {
        status: "aborted",
        actionRequired: null,
        lastError: null,
      });
    }

    broadcastJobUpdate(id, "aborted", "Abort requested", { job: getJob(id) });
    res.json({ ok: true, job: getJob(id) });
  });

  return router;
}
