import { contextBridge, ipcRenderer } from "electron";

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

interface OverlayWindowApi {
  toggleVisibility: () => Promise<boolean>;
  getBounds: () => Promise<OverlayBounds>;
  setBounds: (bounds: OverlayBounds) => Promise<void>;
}

interface PipelineApi {
  start: () => Promise<PipelineSnapshot>;
  stop: () => Promise<PipelineSnapshot>;
  clear: () => Promise<PipelineSnapshot>;
  get: () => Promise<PipelineSnapshot>;
  onUpdate: (listener: (snapshot: PipelineSnapshot) => void) => () => void;
}

interface AuthApi {
  signIn: (input: AuthSignInInput) => Promise<AuthSnapshot>;
  signOut: () => Promise<AuthSnapshot>;
  get: () => Promise<AuthSnapshot>;
}

const overlayApi: OverlayWindowApi = {
  toggleVisibility: () => ipcRenderer.invoke("overlay:toggle"),
  getBounds: () => ipcRenderer.invoke("overlay:get-bounds"),
  setBounds: (bounds: OverlayBounds) =>
    ipcRenderer.invoke("overlay:set-bounds", bounds),
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
  signIn: (input: AuthSignInInput) => ipcRenderer.invoke("auth:sign-in", input),
  signOut: () => ipcRenderer.invoke("auth:sign-out"),
  get: () => ipcRenderer.invoke("auth:get"),
};

contextBridge.exposeInMainWorld("overlay", overlayApi);
contextBridge.exposeInMainWorld("pipelines", pipelineApi);
contextBridge.exposeInMainWorld("auth", authApi);

declare global {
  interface Window {
    overlay: OverlayWindowApi;
    pipelines: PipelineApi;
    auth: AuthApi;
  }
}
