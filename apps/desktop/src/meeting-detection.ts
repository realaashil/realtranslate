export interface DetectionSignals {
  browserUrlMatched: boolean;
  meetingProcessActive: boolean;
  microphoneInUse: boolean;
  systemSpeechDetected: boolean;
}

export interface DetectionEvaluation {
  score: number;
  decision: "auto-start" | "prompt" | "idle";
}

const URL_WEIGHT = 3;
const PROCESS_WEIGHT = 2;
const MIC_WEIGHT = 1;
const SYSTEM_SPEECH_WEIGHT = 1;

export const evaluateMeetingSignals = (
  signals: DetectionSignals,
): DetectionEvaluation => {
  const score =
    (signals.browserUrlMatched ? URL_WEIGHT : 0) +
    (signals.meetingProcessActive ? PROCESS_WEIGHT : 0) +
    (signals.microphoneInUse ? MIC_WEIGHT : 0) +
    (signals.systemSpeechDetected ? SYSTEM_SPEECH_WEIGHT : 0);

  if (score >= 3) {
    return { score, decision: "auto-start" };
  }

  if (score === 2) {
    return { score, decision: "prompt" };
  }

  return { score, decision: "idle" };
};
