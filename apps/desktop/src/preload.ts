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

interface OverlayWindowApi {
  toggleVisibility: () => Promise<boolean>;
  getBounds: () => Promise<OverlayBounds>;
  setBounds: (bounds: OverlayBounds) => Promise<void>;
}

interface PipelineApi {
  start: () => Promise<PipelineSnapshot>;
  stop: () => Promise<PipelineSnapshot>;
  get: () => Promise<PipelineSnapshot>;
  onUpdate: (listener: (snapshot: PipelineSnapshot) => void) => () => void;
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

contextBridge.exposeInMainWorld("overlay", overlayApi);
contextBridge.exposeInMainWorld("pipelines", pipelineApi);

declare global {
  interface Window {
    overlay: OverlayWindowApi;
    pipelines: PipelineApi;
  }
}
