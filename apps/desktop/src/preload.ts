import { contextBridge, ipcRenderer } from "electron";

interface OverlayBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Speaker = "you" | "them";
type UtteranceStatus = "listening" | "processing" | "done" | "failed";

type GeminiSessionState =
  | "disconnected"
  | "connecting"
  | "setup"
  | "ready"
  | "error";

type MeetingLifecycle = "idle" | "prompt" | "active" | "stopping";
type DetectionDecision = "auto-start" | "prompt" | "idle";
type AuthStatus = "signed_out" | "signing_in" | "signed_in";

interface PipelineUtterance {
  id: string;
  speaker: Speaker;
  timestamp: number;
  status: UtteranceStatus;
  originalText: string;
  translatedText: string;
  sourceLang: string;
  targetLang: string;
}

interface AuthSnapshot {
  status: AuthStatus;
  email: string | null;
  userId: string | null;
  error: string | null;
}

interface PipelineSnapshot {
  isRunning: boolean;
  youSessionState: GeminiSessionState;
  themSessionState: GeminiSessionState;
  meetingLifecycle: MeetingLifecycle;
  meetingScore: number;
  meetingDecision: DetectionDecision;
  autoStopSecondsRemaining: number | null;
  utterances: PipelineUtterance[];
  dailyRemainingMs: number | null;
  error: string | null;
  activeLanguagePair: string;
  auth: AuthSnapshot;
}

interface LanguageSettings {
  youSource: string;
  youTarget: string;
  themSource: string;
  themTarget: string;
}

interface AppSettings {
  tokenServiceUrl: string;
  language: LanguageSettings;
}

interface AuthSignInInput {
  email: string;
  password: string;
}

interface OverlayWindowApi {
  toggleVisibility: () => Promise<boolean>;
  getBounds: () => Promise<OverlayBounds>;
  setBounds: (bounds: OverlayBounds) => Promise<void>;
  quit: () => Promise<void>;
}

interface PipelineApi {
  start: () => Promise<PipelineSnapshot>;
  stop: () => Promise<PipelineSnapshot>;
  clear: () => Promise<PipelineSnapshot>;
  get: () => Promise<PipelineSnapshot>;
  onUpdate: (listener: (snapshot: PipelineSnapshot) => void) => () => void;
}

interface SettingsApi {
  get: () => Promise<AppSettings>;
  updateTokenServiceUrl: (url: string) => Promise<AppSettings>;
  updateLanguage: (language: LanguageSettings) => Promise<AppSettings>;
}

interface AuthApi {
  signIn: (input: AuthSignInInput) => Promise<AuthSnapshot>;
  signUp: (input: AuthSignInInput) => Promise<AuthSnapshot>;
  verifyOtp: (email: string, token: string) => Promise<AuthSnapshot>;
  signOut: () => Promise<AuthSnapshot>;
  get: () => Promise<AuthSnapshot>;
}

interface GeminiApi {
  pushMicChunk: (base64Pcm: string) => Promise<void>;
  pushSystemChunk: (base64Pcm: string) => Promise<void>;
  muteSpeaker: (speaker: "you" | "them") => Promise<void>;
  unmuteSpeaker: (speaker: "you" | "them") => Promise<void>;
  onStartSystemAudio: (listener: (sourceId: string) => void) => () => void;
  onStopSystemAudio: (listener: () => void) => () => void;
}

const overlayApi: OverlayWindowApi = {
  toggleVisibility: () => ipcRenderer.invoke("overlay:toggle"),
  getBounds: () => ipcRenderer.invoke("overlay:get-bounds"),
  setBounds: (bounds: OverlayBounds) =>
    ipcRenderer.invoke("overlay:set-bounds", bounds),
  quit: () => ipcRenderer.invoke("app:quit"),
};

const pipelineApi: PipelineApi = {
  start: () => ipcRenderer.invoke("pipelines:start"),
  stop: () => ipcRenderer.invoke("pipelines:stop"),
  clear: () => ipcRenderer.invoke("pipelines:clear"),
  get: () => ipcRenderer.invoke("pipelines:get"),
  onUpdate: (listener) => {
    const handler = (_event: unknown, snapshot: PipelineSnapshot): void => {
      listener(snapshot);
    };

    ipcRenderer.on("pipelines:update", handler);

    return () => {
      ipcRenderer.removeListener("pipelines:update", handler);
    };
  },
};

const authApi: AuthApi = {
  signIn: (input: AuthSignInInput) =>
    ipcRenderer.invoke("auth:sign-in", input),
  signUp: (input: AuthSignInInput) =>
    ipcRenderer.invoke("auth:sign-up", input),
  verifyOtp: (email: string, token: string) =>
    ipcRenderer.invoke("auth:verify-otp", email, token),
  signOut: () => ipcRenderer.invoke("auth:sign-out"),
  get: () => ipcRenderer.invoke("auth:get"),
};

const settingsApi: SettingsApi = {
  get: () => ipcRenderer.invoke("settings:get"),
  updateTokenServiceUrl: (url: string) =>
    ipcRenderer.invoke("settings:update-token-service-url", url),
  updateLanguage: (language: LanguageSettings) =>
    ipcRenderer.invoke("settings:update-language", language),
};

const geminiApi: GeminiApi = {
  pushMicChunk: (base64Pcm: string) =>
    ipcRenderer.invoke("audio:mic-chunk", base64Pcm),
  pushSystemChunk: (base64Pcm: string) =>
    ipcRenderer.invoke("audio:system-chunk", base64Pcm),
  muteSpeaker: (speaker: "you" | "them") =>
    ipcRenderer.invoke("audio:mute-speaker", speaker),
  unmuteSpeaker: (speaker: "you" | "them") =>
    ipcRenderer.invoke("audio:unmute-speaker", speaker),
  onStartSystemAudio: (listener) => {
    const handler = (_event: unknown, sourceId: string) => listener(sourceId);
    ipcRenderer.on("system-audio:start", handler);
    return () => ipcRenderer.removeListener("system-audio:start", handler);
  },
  onStopSystemAudio: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("system-audio:stop", handler);
    return () => ipcRenderer.removeListener("system-audio:stop", handler);
  },
};

contextBridge.exposeInMainWorld("overlay", overlayApi);
contextBridge.exposeInMainWorld("pipelines", pipelineApi);
contextBridge.exposeInMainWorld("auth", authApi);
contextBridge.exposeInMainWorld("settings", settingsApi);
contextBridge.exposeInMainWorld("gemini", geminiApi);

declare global {
  interface Window {
    overlay: OverlayWindowApi;
    pipelines: PipelineApi;
    auth: AuthApi;
    settings: SettingsApi;
    gemini: GeminiApi;
  }
}
