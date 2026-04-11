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
type AuthStatus = "signed_out" | "signing_in" | "signed_in";

interface RateWarning {
  remaining: number;
  limit: number;
}

interface AuthSnapshot {
  status: AuthStatus;
  email: string | null;
  userId: string | null;
  error: string | null;
}

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
  rateWarning: RateWarning | null;
  dailyRemainingMs: number | null;
  sessionResetAtUtc: string | null;
  lastProxyNotice: string | null;
  activeLanguagePair: string;
  auth: AuthSnapshot;
}

const root = document.createElement("main");
root.className = "overlay-root";

root.innerHTML = `
  <header class="overlay-header">
    <div class="title-block">
      <strong>Realtime Translate</strong>
      <p>Live desktop translation overlay</p>
    </div>
    <div class="header-actions">
      <button id="toggle-btn" type="button">Hide</button>
      <button id="pipeline-btn" type="button">Start</button>
      <button id="clear-btn" type="button">Clear</button>
    </div>
  </header>

  <section class="auth-panel" id="auth-panel">
    <div class="auth-summary">
      <span class="status-label">Authentication</span>
      <span id="auth-state" class="status-chip">signed_out</span>
      <span id="auth-user" class="auth-user">Not signed in</span>
    </div>

    <form id="auth-form" class="auth-form">
      <input id="auth-email" type="email" placeholder="you@example.com" required />
      <input id="auth-password" type="password" placeholder="Password" required />
      <button id="auth-signin" type="submit">Sign in</button>
      <button id="auth-signout" type="button">Sign out</button>
    </form>

    <p id="auth-error" class="auth-error"></p>
  </section>

  <section class="status-row">
    <article class="status-card">
      <span class="status-label">Proxy</span>
      <span id="proxy-state" class="status-chip">disconnected</span>
    </article>
    <article class="status-card">
      <span class="status-label">Meeting</span>
      <span id="meeting-state" class="status-chip">idle</span>
    </article>
    <article class="status-card">
      <span class="status-label">Mode</span>
      <span id="pipeline-state" class="status-chip">stopped</span>
    </article>
    <article class="status-card">
      <span class="status-label">Languages</span>
      <span id="lang-pair" class="status-chip">en-US → hi-IN</span>
    </article>
  </section>

  <section class="notice-row">
    <div id="score-line" class="notice">Score: 0 (idle)</div>
    <div id="autostop-line" class="notice">Auto-stop: n/a</div>
    <div id="daily-line" class="notice">Daily remaining: n/a</div>
    <div id="rate-line" class="notice">Rate: n/a</div>
  </section>

  <section class="feed" id="utterance-list"></section>

  <footer class="overlay-footer">
    <span id="proxy-notice">Proxy notice: ready</span>
    <span id="bounds">Bounds: loading...</span>
  </footer>
`;

document.body.append(root);

const boundsNode = document.getElementById("bounds");
const proxyStateNode = document.getElementById("proxy-state");
const meetingStateNode = document.getElementById("meeting-state");
const pipelineStateNode = document.getElementById("pipeline-state");
const langPairNode = document.getElementById("lang-pair");
const scoreNode = document.getElementById("score-line");
const autoStopNode = document.getElementById("autostop-line");
const dailyNode = document.getElementById("daily-line");
const rateNode = document.getElementById("rate-line");
const proxyNoticeNode = document.getElementById("proxy-notice");
const utteranceListNode = document.getElementById("utterance-list");
const authStateNode = document.getElementById("auth-state");
const authUserNode = document.getElementById("auth-user");
const authErrorNode = document.getElementById("auth-error");
const authForm = document.getElementById("auth-form") as HTMLFormElement | null;
const authEmailInput = document.getElementById("auth-email") as HTMLInputElement | null;
const authPasswordInput = document.getElementById("auth-password") as HTMLInputElement | null;
const authSignInButton = document.getElementById("auth-signin") as HTMLButtonElement | null;
const authSignOutButton = document.getElementById("auth-signout") as HTMLButtonElement | null;
const toggleButton = document.getElementById("toggle-btn");
const pipelineButton = document.getElementById("pipeline-btn");
const clearButton = document.getElementById("clear-btn");

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

const formatRemaining = (remainingMs: number | null): string => {
  if (remainingMs === null) {
    return "n/a";
  }

  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
};

const confidenceLabel = (confidence: number): string => {
  return `${(confidence * 100).toFixed(1)}%`;
};

const renderUtterance = (utterance: PipelineUtterance): string => {
  const translatedText =
    utterance.status === "failed"
      ? utterance.translatedText || "(missed)"
      : utterance.translatedText || "(translating...)";

  const speakerLabel = utterance.speaker === "you" ? "YOU" : "THEM";

  return `
    <article class="state-card state-${utterance.status}">
      <header>
        <span class="speaker ${utterance.speaker}">${speakerLabel}</span>
        <span class="state">${utterance.status}</span>
        <time>${formatTime(utterance.timestamp)}</time>
      </header>
      <p class="original">${utterance.originalText || "(waiting for speech)"}</p>
      <p class="translated">${translatedText}</p>
      <footer>
        <span>${utterance.sourceLang}</span>
        <span>→</span>
        <span>${utterance.targetLang}</span>
        <span class="confidence">${confidenceLabel(utterance.confidence)}</span>
      </footer>
    </article>
  `;
};

const chipClass = (value: string): string => {
  if (value === "connected" || value === "running" || value === "active" || value === "signed_in") {
    return "status-chip ok";
  }

  if (
    value === "reconnecting" ||
    value === "prompt" ||
    value === "stopping" ||
    value === "signing_in"
  ) {
    return "status-chip warn";
  }

  if (value === "error") {
    return "status-chip danger";
  }

  return "status-chip";
};

const renderAuth = (auth: AuthSnapshot): void => {
  if (authStateNode) {
    authStateNode.textContent = auth.status;
    authStateNode.className = chipClass(auth.status);
  }

  if (authUserNode) {
    authUserNode.textContent = auth.email ?? "Not signed in";
  }

  if (authErrorNode) {
    authErrorNode.textContent = auth.error ?? "";
  }

  if (authSignInButton) {
    authSignInButton.disabled = auth.status === "signing_in" || auth.status === "signed_in";
  }

  if (authSignOutButton) {
    authSignOutButton.disabled = auth.status !== "signed_in";
  }

  if (authEmailInput) {
    authEmailInput.disabled = auth.status === "signing_in" || auth.status === "signed_in";
  }

  if (authPasswordInput) {
    authPasswordInput.disabled = auth.status === "signing_in" || auth.status === "signed_in";
  }
};

const renderSnapshot = (snapshot: PipelineSnapshot): void => {
  renderAuth(snapshot.auth);

  if (pipelineStateNode) {
    const mode = snapshot.isRunning ? "running" : "stopped";
    pipelineStateNode.textContent = mode;
    pipelineStateNode.className = chipClass(mode);
  }

  if (proxyStateNode) {
    proxyStateNode.textContent = snapshot.proxyConnection;
    proxyStateNode.className = chipClass(snapshot.proxyConnection);
  }

  if (meetingStateNode) {
    meetingStateNode.textContent = snapshot.meetingLifecycle;
    meetingStateNode.className = chipClass(snapshot.meetingLifecycle);
  }

  if (langPairNode) {
    langPairNode.textContent = snapshot.activeLanguagePair;
  }

  if (scoreNode) {
    scoreNode.textContent = `Score: ${snapshot.meetingScore} (${snapshot.meetingDecision})`;
  }

  if (autoStopNode) {
    autoStopNode.textContent =
      snapshot.autoStopSecondsRemaining === null
        ? "Auto-stop: n/a"
        : `Auto-stop in ${snapshot.autoStopSecondsRemaining}s`;
  }

  if (dailyNode) {
    const resetPart = snapshot.sessionResetAtUtc
      ? ` • reset ${snapshot.sessionResetAtUtc}`
      : "";
    dailyNode.textContent = `Daily remaining: ${formatRemaining(snapshot.dailyRemainingMs)}${resetPart}`;
  }

  if (rateNode) {
    if (snapshot.rateWarning) {
      rateNode.textContent = `Rate warning: ${snapshot.rateWarning.remaining}/${snapshot.rateWarning.limit} left`;
    } else {
      rateNode.textContent = "Rate: normal";
    }
  }

  if (proxyNoticeNode) {
    proxyNoticeNode.textContent = `Proxy notice: ${snapshot.lastProxyNotice ?? "none"}`;
  }

  if (pipelineButton) {
    pipelineButton.textContent = snapshot.isRunning ? "Stop" : "Start";
    pipelineButton.toggleAttribute("disabled", snapshot.auth.status !== "signed_in");
  }

  if (!utteranceListNode) {
    return;
  }

  if (snapshot.utterances.length === 0) {
    utteranceListNode.innerHTML =
      '<p class="empty">No captions yet. Sign in and start translation or wait for meeting auto-detection.</p>';
    return;
  }

  utteranceListNode.innerHTML = snapshot.utterances
    .slice(-10)
    .map((item) => renderUtterance(item))
    .join("");
};

const updateBounds = async (): Promise<void> => {
  const bounds = await window.overlay.getBounds();
  if (boundsNode) {
    boundsNode.textContent = formatBounds(bounds);
  }
};

if (!window.overlay || !window.pipelines || !window.auth) {
  throw new Error(
    "Preload bridge unavailable. Ensure desktop app is running via Electron Forge (pnpm dev:desktop).",
  );
}

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

if (clearButton) {
  clearButton.addEventListener("click", async () => {
    const next = await window.pipelines.clear();
    renderSnapshot(next);
  });
}

if (authForm) {
  authForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (!authEmailInput || !authPasswordInput) {
      return;
    }

    const email = authEmailInput.value.trim();
    const password = authPasswordInput.value;

    try {
      await window.auth.signIn({ email, password });
      const latest = await window.pipelines.get();
      renderSnapshot(latest);
    } catch (error) {
      if (authErrorNode) {
        authErrorNode.textContent =
          error instanceof Error ? error.message : "Sign in failed";
      }
    }
  });
}

if (authSignOutButton) {
  authSignOutButton.addEventListener("click", async () => {
    try {
      await window.auth.signOut();
      const latest = await window.pipelines.get();
      renderSnapshot(latest);
    } catch (error) {
      if (authErrorNode) {
        authErrorNode.textContent =
          error instanceof Error ? error.message : "Sign out failed";
      }
    }
  });
}

const unsubscribe = window.pipelines.onUpdate((snapshot) => {
  renderSnapshot(snapshot);
});

void (async () => {
  await updateBounds();
  await window.auth.get();
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
