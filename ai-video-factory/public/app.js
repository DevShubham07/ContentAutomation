(function () {
  "use strict";

  const STAGES = ["gpt", "images", "video", "audio", "final"];
  const STAGE_MAP = {
    "Generating GPT Plan": "gpt",
    "Generating Images": "images",
    "Creating Video": "video",
    "Generating Audio": "audio",
    "Merging Final Video": "final",
    Completed: "final",
    failed: null,
  };

  const themeInput = document.getElementById("theme");
  const generateBtn = document.getElementById("generate");
  const progressSection = document.getElementById("progressSection");
  const progressBar = document.getElementById("progressBar");
  const progressFill = document.getElementById("progressFill");
  const elapsedTimer = document.getElementById("elapsedTimer");
  const pipelineNodes = document.getElementById("pipelineNodes");
  const errorDisplay = document.getElementById("errorDisplay");

  let timerInterval = null;
  let startTime = null;

  function startTimer() {
    startTime = Date.now();
    elapsedTimer.textContent = "0:00";
    timerInterval = setInterval(updateTimer, 1000);
  }

  function stopTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  function updateTimer() {
    if (!startTime || !elapsedTimer) return;
    const sec = Math.floor((Date.now() - startTime) / 1000);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    elapsedTimer.textContent = m + ":" + (s < 10 ? "0" : "") + s;
  }

  function showError(message) {
    if (!errorDisplay) return;
    errorDisplay.textContent = message;
    errorDisplay.classList.remove("hidden");
  }

  function clearError() {
    if (!errorDisplay) return;
    errorDisplay.textContent = "";
    errorDisplay.classList.add("hidden");
  }

  function setProgressByStageIndex(stageKey) {
    const idx = STAGES.indexOf(stageKey);
    const pct = idx >= 0 ? Math.round(((idx + 1) / STAGES.length) * 100) : 0;
    if (progressSection) progressSection.classList.remove("hidden");
    progressFill.style.width = pct + "%";
  }

  function updatePipelineNodes(activeKey, failedKey) {
    if (!pipelineNodes) return;
    const nodes = pipelineNodes.querySelectorAll(".node");
    STAGES.forEach((key, i) => {
      const node = nodes[i];
      if (!node) return;
      node.classList.remove("active", "complete", "failed");
      if (failedKey && key === failedKey) {
        node.classList.add("failed");
      } else if (failedKey && STAGES.indexOf(key) < STAGES.indexOf(failedKey)) {
        node.classList.add("complete");
      } else if (activeKey && key === activeKey) {
        node.classList.add("active");
      } else if (activeKey && STAGES.indexOf(key) < STAGES.indexOf(activeKey)) {
        node.classList.add("complete");
      }
    });
  }

  function resetPipeline() {
    STAGES.forEach((s) => {
      const spinner = document.getElementById("spinner-" + s);
      const check = document.getElementById("check-" + s);
      const fail = document.getElementById("fail-" + s);
      const data = document.getElementById("data-" + s);
      if (spinner) spinner.classList.add("hidden");
      if (check) check.classList.add("hidden");
      if (fail) fail.classList.add("hidden");
      if (data) {
        data.innerHTML = "";
        data.textContent = "";
      }
    });
    document.querySelectorAll(".step").forEach((el) => el.classList.remove("failed"));
    progressFill.style.width = "0%";
    updatePipelineNodes(null, null);
    stopTimer();
    clearError();
  }

  function setStepLoading(stageKey, loading) {
    if (!STAGES.includes(stageKey)) return;
    const spinner = document.getElementById("spinner-" + stageKey);
    const check = document.getElementById("check-" + stageKey);
    const fail = document.getElementById("fail-" + stageKey);
    if (!spinner || !check) return;
    if (loading) {
      spinner.classList.remove("hidden");
      check.classList.add("hidden");
      if (fail) fail.classList.add("hidden");
    } else {
      spinner.classList.add("hidden");
      check.classList.remove("hidden");
      if (fail) fail.classList.add("hidden");
    }
  }

  function setStepComplete(stageKey) {
    setStepLoading(stageKey, false);
  }

  function setStepFailed(stageKey) {
    if (!STAGES.includes(stageKey)) return;
    const step = document.querySelector(".step[data-stage='" + stageKey + "']");
    const spinner = document.getElementById("spinner-" + stageKey);
    const check = document.getElementById("check-" + stageKey);
    const fail = document.getElementById("fail-" + stageKey);
    if (step) step.classList.add("failed");
    if (spinner) spinner.classList.add("hidden");
    if (check) check.classList.add("hidden");
    if (fail) fail.classList.remove("hidden");
  }

  function setGptData(json) {
    const el = document.getElementById("data-gpt");
    if (!el) return;
    const pre = document.createElement("pre");
    pre.className = "fade-in";
    pre.textContent = JSON.stringify(json, null, 2);
    el.innerHTML = "";
    el.appendChild(pre);
  }

  function appendImages(imagePaths) {
    const el = document.getElementById("data-images");
    if (!el || !Array.isArray(imagePaths) || imagePaths.length === 0) return;
    const grid = document.createElement("div");
    grid.className = "thumb-grid";
    imagePaths.forEach((path) => {
      const name = path.split(/[/\\]/).pop();
      const img = document.createElement("img");
      img.src = "/assets/frames/" + name;
      img.alt = name;
      img.loading = "lazy";
      img.onerror = () => {
        img.alt = name + " (load failed)";
      };
      grid.appendChild(img);
    });
    el.appendChild(grid);
  }

  function setVideoData(videoPath) {
    const el = document.getElementById("data-video");
    if (!el) return;
    const name = videoPath.split(/[/\\]/).pop();
    const video = document.createElement("video");
    video.className = "fade-in";
    video.src = "/assets/video/" + name;
    video.controls = true;
    video.preload = "metadata";
    el.innerHTML = "";
    el.appendChild(video);
  }

  function setAudioData(audioPath) {
    const el = document.getElementById("data-audio");
    if (!el) return;
    const name = audioPath.split(/[/\\]/).pop();
    const audio = document.createElement("audio");
    audio.className = "fade-in";
    audio.src = "/assets/audio/" + name;
    audio.controls = true;
    audio.preload = "metadata";
    el.innerHTML = "";
    el.appendChild(audio);
  }

  function setFinalVideoData(finalPath) {
    const el = document.getElementById("data-final");
    if (!el) return;
    const name = finalPath.split(/[/\\]/).pop();
    const video = document.createElement("video");
    video.className = "fade-in";
    video.src = "/assets/" + name;
    video.controls = true;
    video.preload = "metadata";
    el.innerHTML = "";
    el.appendChild(video);
  }

  function connectWs(jobId, onMessage) {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(protocol + "//" + location.host);
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.jobId === jobId) onMessage(msg);
      } catch (_) {}
    };
    ws.onerror = () => {
      showError("WebSocket connection failed. Updates may be delayed.");
    };
    return ws;
  }

  generateBtn.addEventListener("click", async () => {
    const theme = themeInput.value?.trim();
    if (!theme) {
      showError("Please enter a theme.");
      return;
    }

    generateBtn.disabled = true;
    resetPipeline();
    progressSection.classList.remove("hidden");
    startTimer();

    try {
      const res = await fetch("/create-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to create job");
      }

      let currentStage = "gpt";

      const { jobId } = data;
      const ws = connectWs(jobId, (msg) => {
        const { stage, data: d } = msg;

        if (stage === "failed") {
          setStepFailed(currentStage);
          updatePipelineNodes(null, currentStage);
          showError(d?.error || "Pipeline failed");
          generateBtn.disabled = false;
          stopTimer();
          return;
        }

        if (stage === "Generating GPT Plan") {
          currentStage = "gpt";
          setStepLoading("gpt", !d?.json);
          setProgressByStageIndex("gpt");
          updatePipelineNodes("gpt", null);
          if (d?.json) {
            setGptData(d.json);
            setStepComplete("gpt");
          }
        } else if (stage === "Generating Images") {
          currentStage = "images";
          setStepComplete("gpt");
          setStepLoading("images", !d?.images?.length);
          setProgressByStageIndex("images");
          updatePipelineNodes("images", null);
          if (d?.images?.length) {
            appendImages(d.images);
            setStepComplete("images");
          }
        } else if (stage === "Creating Video") {
          currentStage = "video";
          setStepComplete("images");
          setStepLoading("video", !d?.videoPath);
          setProgressByStageIndex("video");
          updatePipelineNodes("video", null);
          if (d?.videoPath) {
            setVideoData(d.videoPath);
            setStepComplete("video");
          }
        } else if (stage === "Generating Audio") {
          currentStage = "audio";
          setStepComplete("video");
          setStepLoading("audio", !d?.audioPath);
          setProgressByStageIndex("audio");
          updatePipelineNodes("audio", null);
          if (d?.audioPath) {
            setAudioData(d.audioPath);
            setStepComplete("audio");
          }
        } else if (stage === "Merging Final Video" || stage === "Completed") {
          currentStage = "final";
          setStepComplete("audio");
          setStepLoading("final", stage !== "Completed");
          setProgressByStageIndex("final");
          updatePipelineNodes("final", null);
          if (d?.finalPath) {
            setFinalVideoData(d.finalPath);
            setStepComplete("final");
            progressFill.style.width = "100%";
            const nodes = pipelineNodes?.querySelectorAll(".node");
            if (nodes) nodes.forEach((n) => n.classList.add("complete"));
            generateBtn.disabled = false;
            stopTimer();
          }
        }
      });

      const pollJob = async () => {
        try {
          const j = await fetch("/jobs/" + jobId).then((r) => r.json());
          if (j.progress != null) {
            progressFill.style.width = j.progress + "%";
          }
          if (j.actionRequired) {
            showError(j.actionRequired);
          } else if (errorDisplay && errorDisplay.textContent && !String(errorDisplay.textContent).includes("failed")) {
            clearError();
          }
          if (j.status === "Completed" || j.status === "failed") {
            clearInterval(interval);
            generateBtn.disabled = false;
            stopTimer();
          }
        } catch (_) {}
      };
      const interval = setInterval(pollJob, 2000);
    } catch (err) {
      showError(err.message || "Failed to start pipeline");
      generateBtn.disabled = false;
      progressSection.classList.add("hidden");
      stopTimer();
    }
  });
})();
