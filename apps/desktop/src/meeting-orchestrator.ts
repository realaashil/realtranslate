import {
  evaluateMeetingSignals,
  type DetectionEvaluation,
  type DetectionSignals,
} from "./meeting-detection";

export type MeetingLifecycle = "idle" | "prompt" | "active" | "stopping";

export interface MeetingSnapshot {
  lifecycle: MeetingLifecycle;
  evaluation: DetectionEvaluation;
  signals: DetectionSignals;
  autoStopSecondsRemaining: number | null;
}

interface MeetingOrchestratorOptions {
  readSignals: () => DetectionSignals;
  onSnapshot: (snapshot: MeetingSnapshot) => void;
  onAutoStart: () => void;
  onAutoStop: () => void;
  pollIntervalMs?: number;
  stopGracePeriodMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_STOP_GRACE_PERIOD_MS = 10_000;

const initialSignals: DetectionSignals = {
  browserUrlMatched: false,
  meetingProcessActive: false,
  microphoneInUse: false,
  systemSpeechDetected: false,
};

const initialEvaluation: DetectionEvaluation = {
  score: 0,
  decision: "idle",
};

export class MeetingOrchestrator {
  private readonly readSignals: () => DetectionSignals;
  private readonly onSnapshot: (snapshot: MeetingSnapshot) => void;
  private readonly onAutoStart: () => void;
  private readonly onAutoStop: () => void;
  private readonly pollIntervalMs: number;
  private readonly stopGracePeriodMs: number;

  private pollTimer: NodeJS.Timeout | null = null;
  private stopTimer: NodeJS.Timeout | null = null;
  private stopDeadlineMs: number | null = null;

  private lifecycle: MeetingLifecycle = "idle";

  constructor(options: MeetingOrchestratorOptions) {
    this.readSignals = options.readSignals;
    this.onSnapshot = options.onSnapshot;
    this.onAutoStart = options.onAutoStart;
    this.onAutoStop = options.onAutoStop;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.stopGracePeriodMs =
      options.stopGracePeriodMs ?? DEFAULT_STOP_GRACE_PERIOD_MS;
  }

  start(): void {
    if (this.pollTimer) {
      return;
    }

    this.tick();
    this.pollTimer = setInterval(() => {
      this.tick();
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    this.clearStopTimer();
  }

  private clearStopTimer(): void {
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }

    this.stopDeadlineMs = null;
  }

  private buildSnapshot(
    signals: DetectionSignals,
    evaluation: DetectionEvaluation,
  ): MeetingSnapshot {
    const autoStopSecondsRemaining =
      this.stopDeadlineMs === null
        ? null
        : Math.max(0, Math.ceil((this.stopDeadlineMs - Date.now()) / 1000));

    return {
      lifecycle: this.lifecycle,
      evaluation,
      signals,
      autoStopSecondsRemaining,
    };
  }

  private enterStoppingState(signals: DetectionSignals): void {
    if (this.lifecycle === "stopping") {
      return;
    }

    this.lifecycle = "stopping";
    this.stopDeadlineMs = Date.now() + this.stopGracePeriodMs;

    this.stopTimer = setTimeout(() => {
      this.lifecycle = "idle";
      this.clearStopTimer();
      this.onAutoStop();

      const latestSignals = this.readSignals();
      const latestEvaluation = evaluateMeetingSignals(latestSignals);
      this.onSnapshot(this.buildSnapshot(latestSignals, latestEvaluation));
    }, this.stopGracePeriodMs);

    const evaluation = evaluateMeetingSignals(signals);
    this.onSnapshot(this.buildSnapshot(signals, evaluation));
  }

  private tick(): void {
    const signals = this.readSignals();
    const evaluation = evaluateMeetingSignals(signals);

    if (evaluation.decision === "auto-start") {
      if (this.lifecycle !== "active") {
        this.lifecycle = "active";
        this.clearStopTimer();
        this.onAutoStart();
      }
    } else if (evaluation.decision === "prompt") {
      if (this.lifecycle === "idle") {
        this.lifecycle = "prompt";
      }

      if (this.lifecycle === "stopping") {
        this.lifecycle = "active";
        this.clearStopTimer();
      }
    } else {
      if (this.lifecycle === "active") {
        this.enterStoppingState(signals);
        return;
      }

      if (this.lifecycle === "prompt") {
        this.lifecycle = "idle";
      }
    }

    this.onSnapshot(this.buildSnapshot(signals, evaluation));
  }
}
