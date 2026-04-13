import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  globalShortcut,
  ipcMain,
} from "electron";
import { createClient, type Session, type User } from "@supabase/supabase-js";
import Store from "electron-store";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import started from "electron-squirrel-startup";

import type { SupportedLanguage, Utterance } from "@realtime/shared";

import {
  MeetingOrchestrator,
  type MeetingSnapshot,
} from "./meeting-orchestrator";
import {
  GeminiSessionManager,
  type LanguageSettings as GeminiLanguageSettings,
  type SessionManagerSnapshot,
  type SessionState,
} from "./gemini-session-manager";
import {
  startSystemAudioCapture,
  getDesktopSourceId,
  type SystemAudioCapture,
} from "./audio-capture";

// ── Types ──

type MeetingLifecycle = "idle" | "prompt" | "active" | "stopping";
type DetectionDecision = "auto-start" | "prompt" | "idle";
type AuthStatus = "signed_out" | "signing_in" | "signed_in";

interface LanguageSettings {
  youSource: string;
  youTarget: string;
  themSource: string;
  themTarget: string;
}

interface AppSettings {
  tokenServiceUrl: string;
  language: LanguageSettings;
  overlayBounds: OverlayBounds;
}

interface OverlayBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface AuthSnapshot {
  status: AuthStatus;
  email: string | null;
  userId: string | null;
  error: string | null;
}

interface PipelineSnapshot {
  isRunning: boolean;
  youSessionState: SessionState;
  themSessionState: SessionState;
  meetingLifecycle: MeetingLifecycle;
  meetingScore: number;
  meetingDecision: DetectionDecision;
  autoStopSecondsRemaining: number | null;
  utterances: Utterance[];
  dailyRemainingMs: number | null;
  error: string | null;
  activeLanguagePair: string;
  auth: AuthSnapshot;
}

interface AuthSignInInput {
  email: string;
  password: string;
}

// ── Constants ──

const MEETING_PROCESS_HINTS = [
  "zoom",
  "teams",
  "slack",
  "discord",
  "webex",
  "meet",
] as const;

const DEFAULT_TOKEN_SERVICE_URL =
  process.env.TOKEN_SERVICE_URL ?? "http://127.0.0.1:8787";
const DEFAULT_LANGUAGE_SETTINGS: LanguageSettings = {
  youSource: "auto",
  youTarget: "hi-IN",
  themSource: "auto",
  themTarget: "en-US",
};
const DEFAULT_OVERLAY_BOUNDS: OverlayBounds = {
  x: 160,
  y: 580,
  width: 980,
  height: 440,
};

// ── State ──

let overlayWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

let isPipelineRunning = false;
let lastSpeechAt = 0;

let authStatus: AuthStatus = "signed_out";
let authUserEmail: string | null = null;
let authUserId: string | null = null;
let authError: string | null = null;
let authAccessToken: string | null = null;

let lastSessionManagerSnapshot: SessionManagerSnapshot | null = null;
let systemAudioCapture: SystemAudioCapture | null = null;

// ── Settings ──

const settingsStore = new Store({
  defaults: {
    tokenServiceUrl: DEFAULT_TOKEN_SERVICE_URL,
    language: DEFAULT_LANGUAGE_SETTINGS,
    overlayBounds: DEFAULT_OVERLAY_BOUNDS,
  },
});

const readSettings = (): AppSettings => {
  const store = settingsStore as unknown as {
    get: <T>(key: string, defaultValue: T) => T;
  };

  return {
    tokenServiceUrl: store.get("tokenServiceUrl", DEFAULT_TOKEN_SERVICE_URL),
    language: store.get("language", DEFAULT_LANGUAGE_SETTINGS),
    overlayBounds: store.get("overlayBounds", DEFAULT_OVERLAY_BOUNDS),
  };
};

const writeSetting = <T>(key: string, value: T): void => {
  const store = settingsStore as unknown as {
    set: <U>(settingKey: string, settingValue: U) => void;
  };
  store.set(key, value);
};

let appSettings: AppSettings = readSettings();

// ── Squirrel Startup ──

if (started) {
  app.quit();
}

// ── Supabase Auth ──

const supabaseUrl = process.env.SUPABASE_URL ?? "";
const supabasePublishableKey =
  process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? "";

if (!supabaseUrl || !supabasePublishableKey) {
  console.error(
    "Missing SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY — auth will not work. Set these env vars at build time.",
  );
}

// Custom storage adapter for Supabase session persistence in Electron main process
const authStore = new Store({ name: "supabase-auth" });
const supabaseStorage = {
  getItem: (key: string): string | null => {
    return (authStore as unknown as { get: (k: string, d: string | null) => string | null }).get(key, null);
  },
  setItem: (key: string, value: string): void => {
    (authStore as unknown as { set: (k: string, v: string) => void }).set(key, value);
  },
  removeItem: (key: string): void => {
    (authStore as unknown as { delete: (k: string) => void }).delete(key);
  },
};

const supabase = createClient(supabaseUrl, supabasePublishableKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    storage: supabaseStorage,
  },
});

// ── Gemini Session Manager ──

const deepgramApiKey = process.env.DEEPGRAM_API_KEY ?? "";

const deviceId = (() => {
  const store = settingsStore as unknown as {
    get: <T>(k: string, d: T) => T;
    set: <T>(k: string, v: T) => void;
  };
  const stored = store.get("deviceId", "");
  if (stored) return stored;
  const id = crypto.randomUUID();
  store.set("deviceId", id);
  return id;
})();

const sessionManager = new GeminiSessionManager({
  tokenServiceUrl: appSettings.tokenServiceUrl,
  deepgramApiKey,
  deviceId,
  language: appSettings.language as GeminiLanguageSettings,
});

sessionManager.onSnapshot((snapshot) => {
  lastSessionManagerSnapshot = snapshot;
  isPipelineRunning = snapshot.isRunning;

  if (snapshot.utterances.length > 0) {
    lastSpeechAt = Date.now();
  }

  emitSnapshot();
});

// ── Meeting Detection ──

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

// ── Auth Helpers ──

const applySession = (
  session: Session | null,
  userOverride?: User | null,
): void => {
  authAccessToken = session?.access_token ?? null;

  const user = userOverride ?? session?.user ?? null;
  authUserEmail = user?.email ?? null;
  authUserId = user?.id ?? null;

  authStatus = session ? "signed_in" : "signed_out";
  sessionManager.setAccessToken(authAccessToken);

  if (!session && isPipelineRunning) {
    stopPipelines();
  }

  emitSnapshot();
};

// ── Snapshot ──

const activeLanguagePair = (): string =>
  `You → ${appSettings.language.youTarget} | Them → ${appSettings.language.themTarget}`;

const authSnapshot = (): AuthSnapshot => ({
  status: authStatus,
  email: authUserEmail,
  userId: authUserId,
  error: authError,
});

const getSnapshot = (): PipelineSnapshot => {
  const smSnapshot = lastSessionManagerSnapshot ?? sessionManager.getSnapshot();

  return {
    isRunning: smSnapshot.isRunning,
    youSessionState: smSnapshot.youSessionState,
    themSessionState: smSnapshot.themSessionState,
    meetingLifecycle: meetingSnapshot.lifecycle,
    meetingScore: meetingSnapshot.evaluation.score,
    meetingDecision: meetingSnapshot.evaluation.decision,
    autoStopSecondsRemaining: meetingSnapshot.autoStopSecondsRemaining,
    utterances: smSnapshot.utterances,
    dailyRemainingMs: smSnapshot.dailyRemainingMs,
    error: smSnapshot.error,
    activeLanguagePair: activeLanguagePair(),
    auth: authSnapshot(),
  };
};

const emitSnapshot = (): void => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.webContents.send("pipelines:update", getSnapshot());
};

// ── Pipeline Controls ──

const startPipelines = async (): Promise<PipelineSnapshot> => {
  if (authStatus !== "signed_in" || !authAccessToken) {
    emitSnapshot();
    return getSnapshot();
  }

  if (isPipelineRunning) return getSnapshot();

  await sessionManager.startSessions();

  // Start system audio capture for the "them" stream
  if (!systemAudioCapture) {
    if (process.platform === "linux") {
      // Linux: main-process capture via parec
      systemAudioCapture = startSystemAudioCapture((base64Pcm) => {
        sessionManager.pushSystemAudio(base64Pcm);
      });
      if (systemAudioCapture) {
        console.log("[Main] System audio capture started (parec)");
      }
    } else {
      // macOS/Windows: renderer-based capture via desktopCapturer
      const sourceId = await getDesktopSourceId();
      if (sourceId && overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send("system-audio:start", sourceId);
        // Track as a capture so stopPipelines can clean up
        systemAudioCapture = {
          stop: () => {
            if (overlayWindow && !overlayWindow.isDestroyed()) {
              overlayWindow.webContents.send("system-audio:stop");
            }
          },
        };
        console.log("[Main] System audio capture started (desktopCapturer)");
      }
    }

    if (!systemAudioCapture) {
      console.warn("[Main] System audio capture unavailable — them stream disabled");
    }
  }

  return getSnapshot();
};

const stopPipelines = (): PipelineSnapshot => {
  if (systemAudioCapture) {
    systemAudioCapture.stop();
    systemAudioCapture = null;
  }
  sessionManager.stopSessions();
  return getSnapshot();
};

const clearUtterances = (): PipelineSnapshot => {
  sessionManager.clearUtterances();
  return getSnapshot();
};

// ── Overlay Window ──

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

const toOverlayBounds = (window: BrowserWindow): OverlayBounds => {
  const bounds = window.getBounds();
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  };
};

const persistOverlayBounds = (): void => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;

  const bounds = toOverlayBounds(overlayWindow);
  appSettings = { ...appSettings, overlayBounds: bounds };
  writeSetting("overlayBounds", bounds);
};

const toggleOverlay = (): boolean => {
  if (!overlayWindow) return false;

  if (overlayWindow.isVisible()) {
    overlayWindow.hide();
    return false;
  }

  overlayWindow.showInactive();
  return true;
};

const resolveTrayIconPath = (): string | null => {
  const candidatePaths = [
    path.join(__dirname, "../assets/trayIcon.png"),
    path.join(__dirname, "../../src/assets/trayIcon.png"),
    path.join(__dirname, "../../../src/assets/trayIcon.png"),
    path.join(process.cwd(), "src/assets/trayIcon.png"),
    path.join(process.cwd(), "apps/desktop/src/assets/trayIcon.png"),
  ];

  return candidatePaths.find((candidate) => fs.existsSync(candidate)) ?? null;
};

const createOverlayWindow = (): BrowserWindow => {
  const preloadPath = resolvePreloadPath();
  const { overlayBounds } = appSettings;

  const window = new BrowserWindow({
    width: overlayBounds.width,
    height: overlayBounds.height,
    x: overlayBounds.x,
    y: overlayBounds.y,
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
  window.on("moved", () => persistOverlayBounds());
  window.on("resized", () => persistOverlayBounds());

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    window.webContents.openDevTools({ mode: "detach" });
  }

  return window;
};

const createTray = (): void => {
  const iconPath = resolveTrayIconPath();
  if (!iconPath) {
    console.warn("[Main] Tray icon not found, skipping tray creation");
    return;
  }
  tray = new Tray(iconPath);

  const menu = Menu.buildFromTemplate([
    { label: "Toggle Overlay", click: () => toggleOverlay() },
    { label: "Start Translation", click: () => void startPipelines() },
    { label: "Stop Translation", click: () => stopPipelines() },
    { label: "Clear Captions", click: () => clearUtterances() },
    { label: "Quit", click: () => app.quit() },
  ]);

  tray.setToolTip("RealTranslate");
  tray.setContextMenu(menu);
  tray.on("click", () => toggleOverlay());
};

const registerShortcuts = (): void => {
  globalShortcut.register("CommandOrControl+Shift+T", () => toggleOverlay());
  globalShortcut.register("CommandOrControl+Shift+P", () => {
    if (isPipelineRunning) {
      stopPipelines();
      return;
    }
    void startPipelines();
  });
  globalShortcut.register("CommandOrControl+Shift+K", () => clearUtterances());
};

// ── Auth ──

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
  return authSnapshot();
};

const signUpWithPassword = async (
  input: AuthSignInInput,
): Promise<AuthSnapshot> => {
  authStatus = "signing_in";
  authError = null;
  emitSnapshot();

  const { data, error } = await supabase.auth.signUp({
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

  if (data.session) {
    applySession(data.session, data.user ?? null);
  } else {
    authStatus = "signed_out";
    authError = "Check your email to confirm your account.";
    emitSnapshot();
  }

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
  return authSnapshot();
};

const getAuthSnapshot = async (): Promise<AuthSnapshot> => {
  const { data } = await supabase.auth.getSession();
  applySession(data.session ?? null, data.session?.user ?? null);
  return authSnapshot();
};

// ── Settings ──

const getSettings = (): AppSettings => appSettings;

const updateTokenServiceUrl = (url: string): AppSettings => {
  const normalized = url.trim();
  if (!normalized) throw new Error("Token service URL cannot be empty");

  appSettings = { ...appSettings, tokenServiceUrl: normalized };
  writeSetting("tokenServiceUrl", normalized);
  sessionManager.updateConfig({ tokenServiceUrl: normalized });
  emitSnapshot();
  return appSettings;
};

const updateLanguage = (language: LanguageSettings): AppSettings => {
  const normalized: LanguageSettings = {
    youSource: "auto",
    youTarget: language.youTarget.trim(),
    themSource: "auto",
    themTarget: language.themTarget.trim(),
  };

  if (!normalized.youTarget || !normalized.themTarget) {
    throw new Error("Target language fields are required");
  }

  appSettings = { ...appSettings, language: normalized };
  writeSetting("language", normalized);
  sessionManager.updateConfig({
    language: normalized as GeminiLanguageSettings,
  });
  emitSnapshot();
  return appSettings;
};

// ── IPC Handlers ──

const registerIpcHandlers = (): void => {
  ipcMain.handle("overlay:toggle", () => toggleOverlay());
  ipcMain.handle("overlay:get-bounds", () => {
    if (!overlayWindow) throw new Error("Overlay window is not initialized");
    return toOverlayBounds(overlayWindow);
  });
  ipcMain.handle("overlay:set-bounds", (_event, bounds: OverlayBounds) => {
    if (!overlayWindow) throw new Error("Overlay window is not initialized");
    overlayWindow.setBounds(bounds);
  });

  ipcMain.handle("pipelines:start", () => startPipelines());
  ipcMain.handle("pipelines:stop", () => stopPipelines());
  ipcMain.handle("pipelines:clear", () => clearUtterances());
  ipcMain.handle("pipelines:get", () => getSnapshot());

  ipcMain.handle("auth:sign-in", (_event, input: AuthSignInInput) =>
    signInWithPassword(input),
  );
  ipcMain.handle("auth:sign-up", (_event, input: AuthSignInInput) =>
    signUpWithPassword(input),
  );
  ipcMain.handle("auth:sign-out", () => signOut());
  ipcMain.handle("auth:get", () => getAuthSnapshot());

  ipcMain.handle("settings:get", () => getSettings());
  ipcMain.handle(
    "settings:update-token-service-url",
    (_event, url: string) => updateTokenServiceUrl(url),
  );
  ipcMain.handle(
    "settings:update-language",
    (_event, language: LanguageSettings) => updateLanguage(language),
  );

  ipcMain.handle("audio:mic-chunk", (_event, base64Pcm: string) => {
    sessionManager.pushMicAudio(base64Pcm);
  });

  ipcMain.handle("audio:system-chunk", (_event, base64Pcm: string) => {
    sessionManager.pushSystemAudio(base64Pcm);
  });

  ipcMain.handle("usage:reset", () => sessionManager.resetUsage());
};

// ── Meeting Detection ──

const processList = (): string[] => {
  try {
    if (process.platform === "win32") {
      const stdout = execFileSync("tasklist", [], { encoding: "utf-8" });
      return stdout
        .split("\n")
        .map((line) => line.trim().toLowerCase())
        .filter(Boolean);
    }

    const stdout = execFileSync("ps", ["-A", "-o", "comm="], {
      encoding: "utf-8",
    });
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

  return {
    browserUrlMatched: meetingProcessActive,
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
    void startPipelines();
  },
  onAutoStop: () => {
    stopPipelines();
  },
});

// ── App Lifecycle ──

app.on("ready", async () => {
  appSettings = readSettings();
  sessionManager.updateConfig({
    tokenServiceUrl: appSettings.tokenServiceUrl,
    language: appSettings.language as GeminiLanguageSettings,
  });

  overlayWindow = createOverlayWindow();
  registerIpcHandlers();
  createTray();
  registerShortcuts();

  const { data } = await supabase.auth.getSession();
  applySession(data.session ?? null, data.session?.user ?? null);

  supabase.auth.onAuthStateChange((_event, session) => {
    applySession(session ?? null, session?.user ?? null);
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
  if (systemAudioCapture) {
    systemAudioCapture.stop();
    systemAudioCapture = null;
  }
  sessionManager.dispose();
  meetingOrchestrator.stop();
  globalShortcut.unregisterAll();
});
