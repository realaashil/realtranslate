import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  globalShortcut,
  ipcMain,
} from "electron";
import fs from "node:fs";
import path from "node:path";
import started from "electron-squirrel-startup";

import {
  MeetingOrchestrator,
  type MeetingSnapshot,
} from "./meeting-orchestrator";
import {
  TranslationProxyClient,
  type ProxyConnectionState,
} from "./proxy-client";

type MeetingLifecycle = "idle" | "prompt" | "active" | "stopping";

type DetectionDecision = "auto-start" | "prompt" | "idle";

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

let overlayWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

const utterances = new Map<string, PipelineUtterance>();
let pipelineIntervals: NodeJS.Timeout[] = [];
let isPipelineRunning = false;
let utteranceSequence = 0;
let proxyConnectionState: ProxyConnectionState = "disconnected";

let meetingSnapshot: MeetingSnapshot = {
  lifecycle: "idle",
  evaluation: {
    score: 0,
    decision: "idle",
  },
  signals: {
    browserUrlMatched: false,
    meetingProcessActive: false,
    microphoneInUse: false,
    systemSpeechDetected: false,
  },
  autoStopSecondsRemaining: null,
};

const youPhrases = [
  "Can everyone hear me clearly?",
  "Let's begin the architecture review.",
  "Please share your deployment status.",
  "I will summarize the action items.",
] as const;

const themPhrases = [
  "Audio is clear from our side.",
  "The API rollout is currently stable.",
  "We completed integration testing.",
  "I will send the final notes shortly.",
] as const;

if (started) {
  app.quit();
}

const getRendererUrl = (): string => {
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    return MAIN_WINDOW_VITE_DEV_SERVER_URL;
  }

  return `file://${path.join(
    __dirname,
    `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`,
  )}`;
};

const compareUtterances = (
  left: PipelineUtterance,
  right: PipelineUtterance,
): number => {
  const delta = left.timestamp - right.timestamp;

  if (Math.abs(delta) <= 50 && left.speaker !== right.speaker) {
    return left.speaker === "them" ? -1 : 1;
  }

  return delta;
};

const getSnapshot = (): PipelineSnapshot => {
  const ordered = [...utterances.values()].sort(compareUtterances);
  return {
    isRunning: isPipelineRunning,
    proxyConnection: proxyConnectionState,
    meetingLifecycle: meetingSnapshot.lifecycle,
    meetingScore: meetingSnapshot.evaluation.score,
    meetingDecision: meetingSnapshot.evaluation.decision,
    autoStopSecondsRemaining: meetingSnapshot.autoStopSecondsRemaining,
    utterances: ordered,
  };
};

const emitSnapshot = (): void => {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return;
  }

  overlayWindow.webContents.send("pipelines:update", getSnapshot());
};

const proxyClient = new TranslationProxyClient({
  url: process.env.PROXY_WS_URL ?? "ws://127.0.0.1:8787/ws",
  onConnectionStateChange: (state) => {
    proxyConnectionState = state;
    emitSnapshot();
  },
});

const toOverlayBounds = (window: BrowserWindow): OverlayBounds => {
  const bounds = window.getBounds();
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  };
};

const updateUtterance = (
  utteranceId: string,
  changes: Partial<PipelineUtterance>,
): void => {
  const current = utterances.get(utteranceId);
  if (!current) {
    return;
  }

  utterances.set(utteranceId, {
    ...current,
    ...changes,
  });

  emitSnapshot();
};

const translateUtterance = async (
  utteranceId: string,
  phrase: string,
): Promise<void> => {
  const current = utterances.get(utteranceId);
  if (!current) {
    return;
  }

  try {
    const translated = await proxyClient.translate({
      utteranceId,
      text: phrase,
      sourceLang: current.sourceLang,
      targetLang: current.targetLang,
      speaker: current.speaker,
    });

    updateUtterance(utteranceId, {
      status: "done",
      translatedText: translated,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Translation request failed";

    updateUtterance(utteranceId, {
      status: "failed",
      translatedText: message,
    });
  }
};

const createPipelineUtterance = (speaker: Speaker): string => {
  const timestamp = Date.now();
  utteranceSequence += 1;

  const utteranceId = `${speaker}-${timestamp}-${utteranceSequence}`;

  const utterance: PipelineUtterance = {
    id: utteranceId,
    speaker,
    timestamp,
    status: "listening",
    originalText: "",
    translatedText: "",
    sourceLang: speaker === "you" ? "en-US" : "es-ES",
    targetLang: speaker === "you" ? "hi-IN" : "en-US",
    confidence: 0,
  };

  utterances.set(utteranceId, utterance);
  emitSnapshot();

  return utteranceId;
};

const scheduleStateProgression = (
  utteranceId: string,
  phrase: string,
): void => {
  const transcribingTimer = setTimeout(() => {
    updateUtterance(utteranceId, {
      status: "transcribing",
      originalText: phrase,
      confidence: 0.93,
    });
  }, 250);

  const translatingTimer = setTimeout(() => {
    updateUtterance(utteranceId, {
      status: "translating",
      originalText: phrase,
      confidence: 0.95,
    });

    void translateUtterance(utteranceId, phrase);
  }, 700);

  pipelineIntervals.push(transcribingTimer, translatingTimer);
};

const runPipelineTick = (speaker: Speaker): void => {
  const phrasePool = speaker === "you" ? youPhrases : themPhrases;
  const phrase = phrasePool[utteranceSequence % phrasePool.length];

  const utteranceId = createPipelineUtterance(speaker);
  scheduleStateProgression(utteranceId, phrase);
};

const clearPipelineTimers = (): void => {
  pipelineIntervals.forEach((timer) => {
    clearTimeout(timer);
    clearInterval(timer);
  });

  pipelineIntervals = [];
};

const startPipelines = (): PipelineSnapshot => {
  if (isPipelineRunning) {
    return getSnapshot();
  }

  isPipelineRunning = true;
  emitSnapshot();

  void proxyClient.connect().catch(() => {
    proxyConnectionState = "error";
    emitSnapshot();
  });

  runPipelineTick("you");
  runPipelineTick("them");

  const youInterval = setInterval(() => {
    runPipelineTick("you");
  }, 6000);

  const themInterval = setInterval(() => {
    runPipelineTick("them");
  }, 5000);

  pipelineIntervals.push(youInterval, themInterval);

  return getSnapshot();
};

const stopPipelines = (): PipelineSnapshot => {
  isPipelineRunning = false;
  clearPipelineTimers();
  proxyClient.disconnect();
  emitSnapshot();
  return getSnapshot();
};

const toggleOverlay = (): boolean => {
  if (!overlayWindow) {
    return false;
  }

  if (overlayWindow.isVisible()) {
    overlayWindow.hide();
    return false;
  }

  overlayWindow.showInactive();
  return true;
};

const resolveTrayIconPath = (): string => {
  const candidatePaths = [
    path.join(__dirname, "../assets/iconTemplate.png"),
    path.join(__dirname, "../../src/assets/iconTemplate.png"),
    path.join(process.cwd(), "src/assets/iconTemplate.png"),
  ];

  const found = candidatePaths.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error("Tray icon asset not found");
  }

  return found;
};

const createOverlayWindow = (): BrowserWindow => {
  const window = new BrowserWindow({
    width: 780,
    height: 320,
    x: 200,
    y: 600,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    hasShadow: false,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    window.loadURL(getRendererUrl());
  } else {
    window.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  return window;
};

const createTray = (): void => {
  tray = new Tray(resolveTrayIconPath());

  const menu = Menu.buildFromTemplate([
    {
      label: "Toggle Overlay",
      click: () => {
        toggleOverlay();
      },
    },
    {
      label: "Start Pipelines",
      click: () => {
        startPipelines();
      },
    },
    {
      label: "Stop Pipelines",
      click: () => {
        stopPipelines();
      },
    },
    {
      label: "Quit",
      click: () => {
        app.quit();
      },
    },
  ]);

  tray.setToolTip("Realtime Translate Overlay");
  tray.setContextMenu(menu);
  tray.on("click", () => {
    toggleOverlay();
  });
};

const registerShortcuts = (): void => {
  globalShortcut.register("CommandOrControl+Shift+T", () => {
    toggleOverlay();
  });

  globalShortcut.register("CommandOrControl+Shift+P", () => {
    if (isPipelineRunning) {
      stopPipelines();
      return;
    }

    startPipelines();
  });
};

const registerIpcHandlers = (): void => {
  ipcMain.handle("overlay:toggle", () => toggleOverlay());

  ipcMain.handle("overlay:get-bounds", () => {
    if (!overlayWindow) {
      throw new Error("Overlay window is not initialized");
    }

    return toOverlayBounds(overlayWindow);
  });

  ipcMain.handle("overlay:set-bounds", (_event, bounds: OverlayBounds) => {
    if (!overlayWindow) {
      throw new Error("Overlay window is not initialized");
    }

    overlayWindow.setBounds(bounds);
  });

  ipcMain.handle("pipelines:start", () => startPipelines());
  ipcMain.handle("pipelines:stop", () => stopPipelines());
  ipcMain.handle("pipelines:get", () => getSnapshot());
};

let simulatedSignalTick = 0;

const readSimulatedSignals = () => {
  simulatedSignalTick += 1;

  const cycle = simulatedSignalTick % 20;
  const activeMeeting = cycle >= 3 && cycle <= 16;

  return {
    browserUrlMatched: activeMeeting && cycle % 2 === 0,
    meetingProcessActive: activeMeeting,
    microphoneInUse: activeMeeting && isPipelineRunning,
    systemSpeechDetected: activeMeeting && cycle % 3 !== 0,
  };
};

const meetingOrchestrator = new MeetingOrchestrator({
  readSignals: readSimulatedSignals,
  onSnapshot: (snapshot) => {
    meetingSnapshot = snapshot;
    emitSnapshot();
  },
  onAutoStart: () => {
    startPipelines();
  },
  onAutoStop: () => {
    stopPipelines();
  },
});

app.on("ready", () => {
  overlayWindow = createOverlayWindow();
  registerIpcHandlers();
  createTray();
  registerShortcuts();
  meetingOrchestrator.start();
  emitSnapshot();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (!overlayWindow) {
    overlayWindow = createOverlayWindow();
  }

  if (overlayWindow && !overlayWindow.isVisible()) {
    overlayWindow.showInactive();
  }

  emitSnapshot();
});

app.on("will-quit", () => {
  clearPipelineTimers();
  meetingOrchestrator.stop();
  proxyClient.dispose();
  globalShortcut.unregisterAll();
});
