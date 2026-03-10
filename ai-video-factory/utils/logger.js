/**
 * logger.js
 * A simple logger that handles console output and optional broadcast to UI.
 */

let broadcastFn = null;
let currentJobId = null;

export const logger = {
  /**
   * Register the broadcast function and the current Job ID.
   */
  register(jobId, broadcast) {
    currentJobId = jobId;
    broadcastFn = broadcast;
  },

  /**
   * Log a message to terminal and optionally broadcast to UI.
   */
  log(message, stage = "info") {
    const timestamp = new Date().toISOString();
    const prefix = currentJobId ? `[Job ${currentJobId.slice(0, 8)}]` : "[System]";
    console.log(`${prefix} ${message}`);

    if (broadcastFn && currentJobId) {
      broadcastFn(currentJobId, stage, message);
    }
  },

  /**
   * Log an error message.
   */
  error(message) {
    this.log(message, "failed");
  },

  /**
   * Log a stage change.
   */
  stage(message, stageName) {
    this.log(`Stage: ${message}`, stageName);
  }
};
