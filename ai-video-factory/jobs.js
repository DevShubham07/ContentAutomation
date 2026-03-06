import { randomUUID } from "node:crypto";

const jobs = new Map();
const MAX_JOBS = 200;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function createJob(theme = "") {
  pruneOldJobs();
  const id = randomUUID();
  const job = {
    id,
    theme,
    status: "pending",
    progress: 0,
    logs: [],
    diagnostics: [],
    currentStep: null,
    stepIndex: -1,
    attempt: 0,
    lastError: null,
    actionRequired: null,
    control: {
      pauseRequested: false,
      abortRequested: false,
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    data: {
      gptJson: null,
      images: [],
      videoPath: null,
      audioPath: null,
      finalPath: null,
      browserbase: {
        sessionId: null,
        replayUrl: null,
        liveUrl: null,
        contextId: null,
      },
    },
  };
  jobs.set(id, job);
  return job;
}

function pruneOldJobs() {
  if (jobs.size <= MAX_JOBS) return;
  const now = Date.now();
  const entries = [...jobs.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
  for (const [id, job] of entries) {
    if (jobs.size <= MAX_JOBS * 0.8) break;
    if (now - (job.createdAt || now) > MAX_AGE_MS) {
      jobs.delete(id);
    }
  }
  if (jobs.size > MAX_JOBS) {
    const toRemove = jobs.size - MAX_JOBS;
    const sorted = [...jobs.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (let i = 0; i < toRemove && i < sorted.length; i++) {
      jobs.delete(sorted[i][0]);
    }
  }
}

export function getJob(id) {
  return jobs.get(id) ?? null;
}

export function updateJob(id, updates) {
  const job = jobs.get(id);
  if (!job) return null;
  for (const [key, value] of Object.entries(updates)) {
    if (key.startsWith("data.")) {
      const dataKey = key.slice(5);
      job.data[dataKey] = value;
    } else if (key.startsWith("control.")) {
      const controlKey = key.slice(8);
      job.control[controlKey] = value;
    } else {
      job[key] = value;
    }
  }
  job.updatedAt = Date.now();
  return job;
}

export function appendJobLog(id, message) {
  const job = jobs.get(id);
  if (!job) return null;
  const line = `[${new Date().toISOString()}] ${message}`;
  job.logs = [...job.logs.slice(-199), line];
  job.updatedAt = Date.now();
  return job;
}

export function appendJobDiagnostic(id, diagnostic) {
  const job = jobs.get(id);
  if (!job) return null;
  const entry = {
    at: new Date().toISOString(),
    ...diagnostic,
  };
  job.diagnostics = [...job.diagnostics.slice(-49), entry];
  job.updatedAt = Date.now();
  return job;
}

export function requestPause(id) {
  return updateJob(id, { "control.pauseRequested": true });
}

export function clearPauseRequest(id) {
  return updateJob(id, { "control.pauseRequested": false });
}

export function requestAbort(id) {
  return updateJob(id, { "control.abortRequested": true });
}

export function clearAbortRequest(id) {
  return updateJob(id, { "control.abortRequested": false });
}

export { jobs };
