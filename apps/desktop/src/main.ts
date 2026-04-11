import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  globalShortcut,
  ipcMain,
} from "electron";
import { createClient, type Session, type User } from "@supabase/supabase-js";
import { execSync } from "node:child_process";
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
  type ServerMessage,
} from "./proxy-client";

type MeetingLifecycle = "idle" | "prompt" | "active" | "stopping";

type DetectionDecision = "auto-start" | "prompt" | "idle";
type AuthStatus = "signed_out" | "signing_in" | "signed_in";

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

interface AuthSignInInput {
  email: string;
  password: string;
}

const MEETING_PROCESS_HINTS = [
  "zoom",
  "teams",
  "slack",
  "discord",
  "webex",
  "meet",
] as const;

const YOU_SOURCE_LANG = "en-US";
const YOU_TARGET_LANG = "hi-IN";
const THEM_SOURCE_LANG = "es-ES";
const THEM_TARGET_LANG = "en-US";

const YOU_PHRASES = [
  "Can everyone hear me clearly?",
  "Let's begin the architecture review.",
  "Please share your deployment status.",
  "I will summarize the action items.",
] as const;

const THEM_PHRASES = [
  "Audio is clear from our side.",
  "The API rollout is currently stable.",
  "We completed integration testing.",
  "I will send the final notes shortly.",
] as const;

let overlayWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

const utterances = new Map<string, PipelineUtterance>();
let pipelineTimers: NodeJS.Timeout[] = [];
let isPipelineRunning = false;
let utteranceSequence = 0;
let proxyConnectionState: ProxyConnectionState = "disconnected";
let lastSpeechAt = 0;

let rateWarning: RateWarning | null = null;
let dailyRemainingMs: number | null = null;
let sessionResetAtUtc: string | null = null;
let lastProxyNotice: string | null = null;

let authStatus: AuthStatus = "signed_out";
let authUserEmail: string | null = null;
let authUserId: string | null = null;
let authError: string | null = null;
let authAccessToken: string | null = null;

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

if (started) {
  app.quit();
}

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Missing SUPABASE_URL or SUPABASE_ANON_KEY for desktop auth",
  );
}

const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
  },
});

const applySession = (session: Session | null, userOverride?: User | null): void => {
  authAccessToken = session?.access_token ?? null;

  const user = userOverride ?? session?.user ?? null;
  authUserEmail = user?.email ?? null;
  authUserId = user?.id ?? null;

  authStatus = session ? "signed_in" : "signed_out";

  if (!session && isPipelineRunning) {
    stopPipelines();
  }

  emitSnapshot();
};

const getRendererUrl = (): string => {
  if (
    typeof MAIN_WINDOW_VITE_DEV_SERVER_URL === "string" &&
    MAIN_WINDOW_VITE_DEV_SERVER_URL.length > 0
  ) {
    return MAIN_WINDOW_VITE_DEV_SERVER_URL;
  }

  return `file://${path.join(
    __dirname,
    `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`,
  )}`;
};

const resolvePreloadPath = (): string => {
  const candidates = [
    path.join(__dirname, "preload.js"),
    path.join(process.cwd(), ".vite/build/preload.js"),
    path.join(process.cwd(), "apps/desktop/.vite/build/preload.js"),
  ];

  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error("Preload bundle not found");
  }

  return found;
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

const activeLanguagePair = (): string => `${YOU_SOURCE_LANG} → ${YOU_TARGET_LANG}`;

const authSnapshot = (): AuthSnapshot => ({
  status: authStatus,
  email: authUserEmail,
  userId: authUserId,
  error: authError,
});

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
    rateWarning,
    dailyRemainingMs,
    sessionResetAtUtc,
    lastProxyNotice,
    activeLanguagePair: activeLanguagePair(),
    auth: authSnapshot(),
  };
};

const emitSnapshot = (): void => {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return;
  }

  overlayWindow.webContents.send("pipelines:update", getSnapshot());
};

const handleProxyServerMessage = (message: ServerMessage): void => {
  switch (message.type) {
    case "auth_ok":
      dailyRemainingMs = message.dailyRemainingMs;
      sessionResetAtUtc = null;
      lastProxyNotice = null;
      break;
    case "rate_warning":
      rateWarning = {
        remaining: message.remaining,
        limit: message.limit,
      };
      break;
    case "session_warning":
      dailyRemainingMs = message.dailyRemainingMs;
      break;
    case "session_expired":
      sessionResetAtUtc = message.resetAtUtc;
      lastProxyNotice = `Session expired. Resets at ${message.resetAtUtc}`;
      break;
    case "rate_limited":
      lastProxyNotice = `Rate limited. Retry after ${message.retryAfterMs}ms`;
      break;
    case "error":
      if (!message.utteranceId) {
        lastProxyNotice = message.message;

        if (message.code === "unauthorized" || message.code === "session_required") {
          authStatus = "signed_out";
          authError = message.message;
          authAccessToken = null;
        }
      }
      break;
    case "translation_chunk":
    case "pong":
      break;
  }

  emitSnapshot();
};

const proxyClient = new TranslationProxyClient({
  url: process.env.PROXY_WS_URL ?? "ws://127.0.0.1:8787/ws",
  credentialsProvider: () => ({
    token: authAccessToken,
    deviceId: process.env.PROXY_DEVICE_ID ?? "desktop-dev-device",
  }),
  onConnectionStateChange: (state) => {
    proxyConnectionState = state;

    if (state === "connected") {
      lastProxyNotice = null;
    }

    emitSnapshot();
  },
  onServerMessage: handleProxyServerMessage,
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

const createPipelineUtterance = (
  speaker: Speaker,
  sourceLang: string,
  targetLang: string,
): string => {
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
    sourceLang,
    targetLang,
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
      confidence: 0.92,
    });
  }, 220);

  const translatingTimer = setTimeout(() => {
    updateUtterance(utteranceId, {
      status: "translating",
      originalText: phrase,
      confidence: 0.96,
    });

    void translateUtterance(utteranceId, phrase);
  }, 700);

  pipelineTimers.push(transcribingTimer, translatingTimer);
};

const runPipelineTick = (speaker: Speaker): void => {
  const phrasePool = speaker === "you" ? YOU_PHRASES : THEM_PHRASES;
  const phrase = phrasePool[utteranceSequence % phrasePool.length];

  const utteranceId =
    speaker === "you"
      ? createPipelineUtterance(speaker, YOU_SOURCE_LANG, YOU_TARGET_LANG)
      : createPipelineUtterance(speaker, THEM_SOURCE_LANG, THEM_TARGET_LANG);

  lastSpeechAt = Date.now();
  scheduleStateProgression(utteranceId, phrase);
};

const clearPipelineTimers = (): void => {
  pipelineTimers.forEach((timer) => {
    clearTimeout(timer);
    clearInterval(timer);
  });

  pipelineTimers = [];
};

const clearUtterances = (): PipelineSnapshot => {
  utterances.clear();
  emitSnapshot();
  return getSnapshot();
};

const startPipelines = (): PipelineSnapshot => {
  if (authStatus !== "signed_in" || !authAccessToken) {
    lastProxyNotice = "Sign in with email before starting translation";
    emitSnapshot();
    return getSnapshot();
  }

  if (isPipelineRunning) {
    return getSnapshot();
  }

  isPipelineRunning = true;
  rateWarning = null;
  sessionResetAtUtc = null;
  lastProxyNotice = null;

  emitSnapshot();

  void proxyClient.connect().catch((error) => {
    proxyConnectionState = "error";
    lastProxyNotice =
      error instanceof Error ? error.message : "Unable to connect proxy";
    emitSnapshot();
  });

  runPipelineTick("you");
  runPipelineTick("them");

  const youInterval = setInterval(() => {
    runPipelineTick("you");
  }, 5800);

  const themInterval = setInterval(() => {
    runPipelineTick("them");
  }, 5200);

  pipelineTimers.push(youInterval, themInterval);

  return getSnapshot();
};

const stopPipelines = (): PipelineSnapshot => {
  isPipelineRunning = false;
  clearPipelineTimers();
  proxyClient.disconnect("meeting_ended");
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
  const preloadPath = resolvePreloadPath();

  const window = new BrowserWindow({
    width: 980,
    height: 440,
    x: 160,
    y: 580,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    hasShadow: false,
    resizable: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (
    typeof MAIN_WINDOW_VITE_DEV_SERVER_URL === "string" &&
    MAIN_WINDOW_VITE_DEV_SERVER_URL.length > 0
  ) {
    window.loadURL(getRendererUrl());
  } else {
    window.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    window.webContents.openDevTools({ mode: "detach" });
  }

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
      label: "Start Translation",
      click: () => {
        startPipelines();
      },
    },
    {
      label: "Stop Translation",
      click: () => {
        stopPipelines();
      },
    },
    {
      label: "Clear Captions",
      click: () => {
        clearUtterances();
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

  globalShortcut.register("CommandOrControl+Shift+K", () => {
    clearUtterances();
  });
};

const signInWithPassword = async (
  input: AuthSignInInput,
): Promise<AuthSnapshot> => {
  authStatus = "signing_in";
  authError = null;
  emitSnapshot();

  const { data, error } = await supabase.auth.signInWithPassword({
    email: input.email,
    password: input.password,
  });

  if (error) {
    authStatus = "signed_out";
    authError = error.message;
    authAccessToken = null;
    emitSnapshot();
    throw new Error(error.message);
  }

  applySession(data.session ?? null, data.user ?? null);
  authError = null;
  proxyClient.setCredentials({ token: authAccessToken });

  return authSnapshot();
};

const signOut = async (): Promise<AuthSnapshot> => {
  const { error } = await supabase.auth.signOut();
  if (error) {
    authError = error.message;
    emitSnapshot();
    throw new Error(error.message);
  }

  applySession(null, null);
  authError = null;
  proxyClient.setCredentials({ token: null });

  return authSnapshot();
};

const getAuthSnapshot = async (): Promise<AuthSnapshot> => {
  const { data } = await supabase.auth.getSession();
  applySession(data.session ?? null, data.session?.user ?? null);
  return authSnapshot();
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
  ipcMain.handle("pipelines:clear", () => clearUtterances());
  ipcMain.handle("pipelines:get", () => getSnapshot());

  ipcMain.handle("auth:sign-in", (_event, input: AuthSignInInput) =>
    signInWithPassword(input),
  );
  ipcMain.handle("auth:sign-out", () => signOut());
  ipcMain.handle("auth:get", () => getAuthSnapshot());
};

const processList = (): string[] => {
  try {
    if (process.platform === "win32") {
      const stdout = execSync("tasklist", { encoding: "utf-8" });
      return stdout
        .split("\n")
        .map((line) => line.trim().toLowerCase())
        .filter(Boolean);
    }

    const stdout = execSync("ps -A -o comm=", { encoding: "utf-8" });
    return stdout
      .split("\n")
      .map((line) => path.basename(line.trim()).toLowerCase())
      .filter(Boolean);
  } catch {
    return [];
  }
};

const readRuntimeSignals = () => {
  const processes = processList();

  const meetingProcessActive = processes.some((processName) =>
    MEETING_PROCESS_HINTS.some((hint) => processName.includes(hint)),
  );

  const browserUrlMatched = meetingProcessActive;

  return {
    browserUrlMatched,
    meetingProcessActive,
    microphoneInUse: isPipelineRunning,
    systemSpeechDetected: Date.now() - lastSpeechAt < 6000,
  };
};

const meetingOrchestrator = new MeetingOrchestrator({
  readSignals: readRuntimeSignals,
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

app.on("ready", async () => {
  overlayWindow = createOverlayWindow();
  registerIpcHandlers();
  createTray();
  registerShortcuts();

  const { data } = await supabase.auth.getSession();
  applySession(data.session ?? null, data.session?.user ?? null);

  supabase.auth.onAuthStateChange((_event, session) => {
    applySession(session ?? null, session?.user ?? null);

    proxyClient.setCredentials({
      token: session?.access_token ?? null,
    });
  });

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
