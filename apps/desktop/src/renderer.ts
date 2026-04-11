import "./index.css";

interface OverlayBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Speaker = "you" | "them";
type UtteranceStatus =
  | "listening"
  | "transcribing"
  | "translating"
  | "done"
  | "failed";

type ProxyConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

type MeetingLifecycle = "idle" | "prompt" | "active" | "stopping";
type DetectionDecision = "auto-start" | "prompt" | "idle";

interface PipelineUtterance {
  id: string;
  speaker: Speaker;
  timestamp: number;
  status: UtteranceStatus;
  originalText: string;
  translatedText: string;
  sourceLang: string;
  targetLang: string;
  confidence: number;
}

interface PipelineSnapshot {
  isRunning: boolean;
  proxyConnection: ProxyConnectionState;
  meetingLifecycle: MeetingLifecycle;
  meetingScore: number;
  meetingDecision: DetectionDecision;
  autoStopSecondsRemaining: number | null;
  utterances: PipelineUtterance[];
}

const root = document.createElement("main");
root.className = "overlay-root";

root.innerHTML = `
  <header class="overlay-header">
    <div>
      <strong>Realtime Translate Overlay</strong>
      <p>Dual pipelines + proxy transport + meeting orchestration</p>
    </div>
    <div class="header-actions">
      <button id="toggle-btn" type="button">Toggle</button>
      <button id="pipeline-btn" type="button">Start Pipelines</button>
    </div>
  </header>

  <section class="overlay-status-grid">
    <span id="pipeline-state">Pipelines: stopped</span>
    <span id="proxy-state">Proxy: disconnected</span>
    <span id="meeting-state">Meeting: idle</span>
    <span id="meeting-score">Score: 0 (idle)</span>
  </section>

  <section class="overlay-body" id="utterance-list"></section>

  <footer class="overlay-footer">
    <span id="bounds">Bounds: loading...</span>
    <span id="autostop">Auto-stop: n/a</span>
  </footer>
`;

document.body.append(root);

const boundsNode = document.getElementById("bounds");
const pipelineStateNode = document.getElementById("pipeline-state");
const proxyStateNode = document.getElementById("proxy-state");
const meetingStateNode = document.getElementById("meeting-state");
const meetingScoreNode = document.getElementById("meeting-score");
const autoStopNode = document.getElementById("autostop");
const utteranceListNode = document.getElementById("utterance-list");
const toggleButton = document.getElementById("toggle-btn");
const pipelineButton = document.getElementById("pipeline-btn");

const formatBounds = (bounds: OverlayBounds): string => {
  return `Bounds: x=${bounds.x}, y=${bounds.y}, w=${bounds.width}, h=${bounds.height}`;
};

const formatTime = (timestamp: number): string => {
  const date = new Date(timestamp);
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
};

const renderUtterance = (utterance: PipelineUtterance): string => {
  const translatedText =
    utterance.status === "failed"
      ? utterance.translatedText || "(missed)"
      : utterance.translatedText || "(translating...)";

  return `
    <article class="state-card state-${utterance.status}">
      <header>
        <span class="speaker ${utterance.speaker}">${utterance.speaker.toUpperCase()}</span>
        <span class="state">${utterance.status}</span>
        <time>${formatTime(utterance.timestamp)}</time>
      </header>
      <p class="original">${utterance.originalText || "(waiting for speech)"}</p>
      <p class="translated">${translatedText}</p>
      <footer>
        <span>${utterance.sourceLang}</span>
        <span>→</span>
        <span>${utterance.targetLang}</span>
        <span class="confidence">${(utterance.confidence * 100).toFixed(1)}%</span>
      </footer>
    </article>
  `;
};

const renderSnapshot = (snapshot: PipelineSnapshot): void => {
  if (pipelineStateNode) {
    pipelineStateNode.textContent = `Pipelines: ${snapshot.isRunning ? "running" : "stopped"}`;
  }

  if (proxyStateNode) {
    proxyStateNode.textContent = `Proxy: ${snapshot.proxyConnection}`;
  }

  if (meetingStateNode) {
    meetingStateNode.textContent = `Meeting: ${snapshot.meetingLifecycle}`;
  }

  if (meetingScoreNode) {
    meetingScoreNode.textContent = `Score: ${snapshot.meetingScore} (${snapshot.meetingDecision})`;
  }

  if (autoStopNode) {
    autoStopNode.textContent =
      snapshot.autoStopSecondsRemaining === null
        ? "Auto-stop: n/a"
        : `Auto-stop: ${snapshot.autoStopSecondsRemaining}s`;
  }

  if (pipelineButton) {
    pipelineButton.textContent = snapshot.isRunning
      ? "Stop Pipelines"
      : "Start Pipelines";
  }

  if (!utteranceListNode) {
    return;
  }

  if (snapshot.utterances.length === 0) {
    utteranceListNode.innerHTML =
      '<p class="empty">No utterances yet. Meeting orchestrator will auto-start pipelines on detected meeting windows.</p>';
    return;
  }

  utteranceListNode.innerHTML = snapshot.utterances
    .slice(-8)
    .map((item) => renderUtterance(item))
    .join("");
};

const updateBounds = async (): Promise<void> => {
  const bounds = await window.overlay.getBounds();
  if (boundsNode) {
    boundsNode.textContent = formatBounds(bounds);
  }
};

if (toggleButton) {
  toggleButton.addEventListener("click", async () => {
    await window.overlay.toggleVisibility();
    await updateBounds();
  });
}

if (pipelineButton) {
  pipelineButton.addEventListener("click", async () => {
    const snapshot = await window.pipelines.get();
    const next = snapshot.isRunning
      ? await window.pipelines.stop()
      : await window.pipelines.start();

    renderSnapshot(next);
  });
}

const unsubscribe = window.pipelines.onUpdate((snapshot) => {
  renderSnapshot(snapshot);
});

void (async () => {
  await updateBounds();
  const initial = await window.pipelines.get();
  renderSnapshot(initial);
})();

const refreshTimer = window.setInterval(() => {
  void updateBounds();
}, 1500);

window.addEventListener("beforeunload", () => {
  window.clearInterval(refreshTimer);
  unsubscribe();
});
