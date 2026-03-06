const MAX_CONCURRENT = 2;

const queue = [];
const queuedIds = new Set();
const runningIds = new Set();
let running = 0;
let runPipelineFn = null;
let broadcastFn = null;

async function getJobsApi() {
  return import("../jobs.js");
}

export function setPipelineRunner(fn) {
  runPipelineFn = fn;
}

export function setBroadcast(fn) {
  broadcastFn = fn;
}

export function enqueue(jobId, theme, options = {}) {
  const { force = false } = options;
  if (!force && (queuedIds.has(jobId) || runningIds.has(jobId))) {
    return false;
  }
  queue.push({ jobId, theme });
  queuedIds.add(jobId);
  processNext();
  return true;
}

export async function enqueueResume(jobId) {
  const { getJob } = await getJobsApi();
  const job = getJob(jobId);
  if (!job) return false;
  return enqueue(jobId, job.theme, { force: true });
}

export function dequeueJob(jobId) {
  const index = queue.findIndex((entry) => entry.jobId === jobId);
  if (index === -1) return false;
  queue.splice(index, 1);
  queuedIds.delete(jobId);
  return true;
}

async function processNext() {
  if (running >= MAX_CONCURRENT || queue.length === 0 || !runPipelineFn || !broadcastFn) {
    return;
  }

  const { jobId, theme } = queue.shift();
  queuedIds.delete(jobId);
  const { getJob, updateJob } = await getJobsApi();
  const job = getJob(jobId);
  if (!job || job.status === "aborted" || job.status === "completed") {
    processNext();
    return;
  }

  runningIds.add(jobId);
  running += 1;
  updateJob(jobId, { status: "running" });

  const broadcast = (id, stage, payload) => broadcastFn(id, stage, stage, payload);

  runPipelineFn(jobId, theme, broadcast)
    .catch((err) => {
      console.error(`Pipeline failed for job ${jobId}:`, err.message);
    })
    .finally(() => {
      runningIds.delete(jobId);
      running -= 1;
      processNext();
    });
}

export function getQueueLength() {
  return queue.length;
}

export function getRunningCount() {
  return running;
}

export function isJobActive(jobId) {
  return queuedIds.has(jobId) || runningIds.has(jobId);
}

export function drain() {
  return new Promise((resolve) => {
    const check = () => {
      if (running === 0 && queue.length === 0) {
        resolve();
      } else {
        setTimeout(check, 100);
      }
    };
    check();
  });
}
