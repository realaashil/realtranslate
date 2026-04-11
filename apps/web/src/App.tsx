import { ConversationQueue, VAD_CONFIG, type Utterance } from "@realtime/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import "./App.css";

type MicStatus =
  | "unsupported"
  | "idle"
  | "starting"
  | "listening"
  | "stopped"
  | "error";

interface BrowserSpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface BrowserSpeechRecognitionResult {
  isFinal: boolean;
  length: number;
  [index: number]: BrowserSpeechRecognitionAlternative;
}

interface BrowserSpeechRecognitionResultList {
  length: number;
  [index: number]: BrowserSpeechRecognitionResult;
}

interface BrowserSpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: BrowserSpeechRecognitionResultList;
}

interface BrowserSpeechRecognitionErrorEvent extends Event {
  error: string;
  message: string;
}

interface BrowserSpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onstart: ((event: Event) => void) | null;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  onerror: ((event: BrowserSpeechRecognitionErrorEvent) => void) | null;
  onend: ((event: Event) => void) | null;
  start: () => void;
  stop: () => void;
}

interface BrowserSpeechRecognitionConstructor {
  new (): BrowserSpeechRecognition;
}

interface BrowserWindowWithSpeech extends Window {
  webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
  SpeechRecognition?: BrowserSpeechRecognitionConstructor;
  webkitAudioContext?: typeof AudioContext;
}

const LANGUAGE_OPTIONS = [
  { value: "en-US", label: "English (US)" },
  { value: "hi-IN", label: "Hindi" },
  { value: "es-ES", label: "Spanish" },
  { value: "fr-FR", label: "French" },
] as const;

type LanguageCode = (typeof LANGUAGE_OPTIONS)[number]["value"];

const isLanguageCode = (value: string): value is LanguageCode =>
  LANGUAGE_OPTIONS.some((option) => option.value === value);

const getSpeechRecognitionConstructor =
  (): BrowserSpeechRecognitionConstructor | null => {
    const speechWindow = window as BrowserWindowWithSpeech;

    return (
      speechWindow.SpeechRecognition ??
      speechWindow.webkitSpeechRecognition ??
      null
    );
  };

const toTimeLabel = (timestamp: number): string => {
  const date = new Date(timestamp);
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
};

interface TranslateRequest {
  utteranceId: string;
  text: string;
  sourceLang: string;
  targetLang: string;
}

interface TranslationChunkResponse {
  type: "translation_chunk";
  utteranceId: string;
  chunk: string;
  done: boolean;
}

interface TranslationErrorResponse {
  type: "error";
  code:
    | "unauthorized"
    | "device_mismatch"
    | "invalid_payload"
    | "translation_failed";
  message: string;
  utteranceId?: string;
}

const requestTranslation = async (
  input: TranslateRequest,
): Promise<TranslationChunkResponse | TranslationErrorResponse> => {
  const response = await fetch("/api/message", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      type: "translate",
      utteranceId: input.utteranceId,
      text: input.text,
      sourceLang: input.sourceLang,
      targetLang: input.targetLang,
      speaker: "you",
    }),
  });

  const payload: unknown = await response.json();

  if (
    typeof payload === "object" &&
    payload !== null &&
    "type" in payload &&
    (payload as { type: unknown }).type === "translation_chunk"
  ) {
    const chunk = payload as TranslationChunkResponse;
    return chunk;
  }

  if (
    typeof payload === "object" &&
    payload !== null &&
    "type" in payload &&
    (payload as { type: unknown }).type === "error"
  ) {
    const error = payload as TranslationErrorResponse;
    return error;
  }

  return {
    type: "error",
    code: "translation_failed",
    message: "Unexpected translation response",
  };
};

function App() {
  const recognitionConstructor = useMemo(
    () => getSpeechRecognitionConstructor(),
    [],
  );

  const [status, setStatus] = useState<MicStatus>(
    recognitionConstructor ? "idle" : "unsupported",
  );
  const [errorText, setErrorText] = useState<string>("");
  const [sourceLanguage, setSourceLanguage] = useState<LanguageCode>("en-US");
  const [targetLanguage, setTargetLanguage] = useState<LanguageCode>("hi-IN");
  const [interimText, setInterimText] = useState<string>("");
  const [utterances, setUtterances] = useState<Utterance[]>([]);
  const [vadScore, setVadScore] = useState<number>(0);
  const [silenceMs, setSilenceMs] = useState<number>(0);
  const [punctuationHint, setPunctuationHint] = useState<
    "none" | "comma" | "period" | "paragraph"
  >("none");

  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const vadIntervalRef = useRef<number | null>(null);
  const silenceStartedAtRef = useRef<number | null>(null);
  const queueRef = useRef<ConversationQueue>(new ConversationQueue());
  const activeUtteranceIdRef = useRef<string | null>(null);
  const translationAbortControllersRef = useRef<Map<string, AbortController>>(
    new Map(),
  );

  const syncQueue = useCallback(() => {
    setUtterances(queueRef.current.getOrdered());
  }, []);

  const clearPendingTranslations = useCallback(() => {
    translationAbortControllersRef.current.forEach((controller) => {
      controller.abort();
    });
    translationAbortControllersRef.current.clear();
  }, []);

  const stopVADMonitoring = useCallback((): void => {
    if (vadIntervalRef.current !== null) {
      window.clearInterval(vadIntervalRef.current);
      vadIntervalRef.current = null;
    }

    analyserRef.current?.disconnect();
    analyserRef.current = null;

    audioSourceRef.current?.disconnect();
    audioSourceRef.current = null;

    audioDataRef.current = null;

    if (audioContextRef.current) {
      void audioContextRef.current.close();
      audioContextRef.current = null;
    }

    silenceStartedAtRef.current = null;
    setVadScore(0);
    setSilenceMs(0);
    setPunctuationHint("none");
  }, []);

  const stopMicrophoneTracks = useCallback((): void => {
    const stream = streamRef.current;
    if (!stream) {
      return;
    }

    stream.getTracks().forEach((track) => {
      track.stop();
    });

    streamRef.current = null;
  }, []);

  const startVADMonitoring = useCallback((stream: MediaStream): void => {
    stopVADMonitoring();

    const speechWindow = window as BrowserWindowWithSpeech;
    const AudioContextCtor = window.AudioContext ?? speechWindow.webkitAudioContext;

    if (!AudioContextCtor) {
      return;
    }

    const context = new AudioContextCtor();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.1;

    source.connect(analyser);

    audioContextRef.current = context;
    audioSourceRef.current = source;
    analyserRef.current = analyser;

    const data = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
    audioDataRef.current = data;

    vadIntervalRef.current = window.setInterval(() => {
      const currentAnalyser = analyserRef.current;
      const currentData = audioDataRef.current;

      if (!currentAnalyser || !currentData) {
        return;
      }

      currentAnalyser.getByteTimeDomainData(currentData);

      let sumSquares = 0;
      for (let index = 0; index < currentData.length; index += 1) {
        const centered = (currentData[index] - 128) / 128;
        sumSquares += centered * centered;
      }

      const rms = Math.sqrt(sumSquares / currentData.length);
      const normalized = Math.min(1, Math.max(0, (rms - 0.01) / 0.08));
      setVadScore(normalized);

      if (normalized >= VAD_CONFIG.speechThreshold) {
        silenceStartedAtRef.current = null;
        setSilenceMs(0);
        setPunctuationHint("none");
        return;
      }

      const now = Date.now();
      if (silenceStartedAtRef.current === null) {
        silenceStartedAtRef.current = now;
      }

      const silentFor = now - silenceStartedAtRef.current;
      setSilenceMs(silentFor);

      if (silentFor >= VAD_CONFIG.paragraphPauseMs) {
        setPunctuationHint("paragraph");
      } else if (silentFor >= VAD_CONFIG.sentencePauseMs) {
        setPunctuationHint("period");
      } else if (silentFor >= VAD_CONFIG.commaPauseMs) {
        setPunctuationHint("comma");
      } else {
        setPunctuationHint("none");
      }
    }, 120);
  }, [stopVADMonitoring]);

  const ensureActiveUtterance = useCallback((): string => {
    const existingId = activeUtteranceIdRef.current;

    if (existingId) {
      const existing = queueRef.current.getById(existingId);
      if (existing) {
        return existingId;
      }
    }

    const created = queueRef.current.create({
      speaker: "you",
      timestamp: Date.now(),
      sourceLang: sourceLanguage,
      targetLang: targetLanguage,
    });

    activeUtteranceIdRef.current = created.id;
    syncQueue();

    return created.id;
  }, [sourceLanguage, syncQueue, targetLanguage]);

  const runTranslation = useCallback(
    async (
      utteranceId: string,
      text: string,
      sourceLang: string,
      targetLang: string,
    ) => {
      const controller = new AbortController();
      translationAbortControllersRef.current.set(utteranceId, controller);

      try {
        const response = await requestTranslation({
          utteranceId,
          text,
          sourceLang,
          targetLang,
        });

        const existing = queueRef.current.getById(utteranceId);
        if (!existing || existing.status === "failed") {
          return;
        }

        if (response.type === "translation_chunk") {
          queueRef.current.upsert(utteranceId, {
            status: response.done ? "done" : "translating",
            translatedText: response.chunk,
          });
        } else {
          queueRef.current.upsert(utteranceId, {
            status: "failed",
            translatedText: response.message,
          });
          setErrorText(response.message);
        }

        syncQueue();
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }

        const message =
          error instanceof Error ? error.message : "Translation request failed";

        queueRef.current.upsert(utteranceId, {
          status: "failed",
          translatedText: message,
        });
        setErrorText(message);
        syncQueue();
      } finally {
        translationAbortControllersRef.current.delete(utteranceId);
      }
    },
    [syncQueue],
  );

  const stopListening = useCallback((): void => {
    const recognition = recognitionRef.current;
    if (!recognition) {
      stopVADMonitoring();
      stopMicrophoneTracks();
      return;
    }

    recognition.stop();
    stopVADMonitoring();
    stopMicrophoneTracks();
  }, [stopMicrophoneTracks, stopVADMonitoring]);

  const startListening = useCallback(async (): Promise<void> => {
    if (!recognitionConstructor) {
      setStatus("unsupported");
      setErrorText("This browser does not support Web Speech API.");
      return;
    }

    setStatus("starting");
    setErrorText("");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      streamRef.current = stream;
      startVADMonitoring(stream);

      const recognition = new recognitionConstructor();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = sourceLanguage;
      recognition.maxAlternatives = 1;

      recognition.onstart = () => {
        setStatus("listening");
      };

      recognition.onresult = (event) => {
        let latestInterim = "";

        for (
          let index = event.resultIndex;
          index < event.results.length;
          index += 1
        ) {
          const result = event.results[index];
          const topAlternative = result[0];
          const transcript = topAlternative?.transcript.trim() ?? "";

          if (transcript.length === 0) {
            continue;
          }

          const utteranceId = ensureActiveUtterance();

          if (result.isFinal) {
            queueRef.current.upsert(utteranceId, {
              status: "translating",
              originalText: transcript,
              confidence: topAlternative.confidence,
            });

            activeUtteranceIdRef.current = null;
            setInterimText("");
            void runTranslation(
              utteranceId,
              transcript,
              sourceLanguage,
              targetLanguage,
            );
          } else {
            latestInterim = transcript;

            queueRef.current.upsert(utteranceId, {
              status: "transcribing",
              originalText: transcript,
              confidence: topAlternative.confidence,
            });
          }
        }

        setInterimText(latestInterim);
        syncQueue();
      };

      recognition.onerror = (event) => {
        setStatus("error");
        setErrorText(event.message || event.error);

        const activeId = activeUtteranceIdRef.current;
        if (activeId) {
          queueRef.current.upsert(activeId, { status: "failed" });
          activeUtteranceIdRef.current = null;
          syncQueue();
        }
      };

      recognition.onend = () => {
        setStatus((current) => (current === "error" ? current : "stopped"));
        setInterimText("");
        activeUtteranceIdRef.current = null;
        stopVADMonitoring();
      };

      recognitionRef.current = recognition;
      recognition.start();
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unable to access microphone permission.";

      setStatus("error");
      setErrorText(message);
      stopVADMonitoring();
      stopMicrophoneTracks();
    }
  }, [
    ensureActiveUtterance,
    recognitionConstructor,
    runTranslation,
    sourceLanguage,
    startVADMonitoring,
    stopMicrophoneTracks,
    stopVADMonitoring,
    syncQueue,
    targetLanguage,
  ]);

  const clearTranscript = useCallback(() => {
    clearPendingTranslations();
    queueRef.current = new ConversationQueue();
    activeUtteranceIdRef.current = null;
    silenceStartedAtRef.current = null;
    setInterimText("");
    setUtterances([]);
    setVadScore(0);
    setSilenceMs(0);
    setPunctuationHint("none");
  }, [clearPendingTranslations]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      const failed = queueRef.current.markTimedOut(Date.now());
      if (failed.length > 0) {
        syncQueue();
      }
    }, 500);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [syncQueue]);

  useEffect(() => {
    return () => {
      clearPendingTranslations();
      stopListening();
    };
  }, [clearPendingTranslations, stopListening]);

  const canStart =
    status === "idle" || status === "stopped" || status === "error";
  const canStop = status === "starting" || status === "listening";

  return (
    <main className="mic-app">
      <header className="mic-header">
        <h1>Web Queue + VAD Component</h1>
        <p>
          Component 3 adds VAD scoring and pause thresholds for comma, period,
          and paragraph hints while preserving queue state flow.
        </p>
      </header>

      <section className="mic-controls">
        <div className="language-grid">
          <label htmlFor="sourceLanguage">Source language</label>
          <select
            id="sourceLanguage"
            value={sourceLanguage}
            onChange={(event) => {
              const value = event.target.value;
              if (isLanguageCode(value)) {
                setSourceLanguage(value);
              }
            }}
            disabled={status === "starting" || status === "listening"}
          >
            {LANGUAGE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          <label htmlFor="targetLanguage">Target language</label>
          <select
            id="targetLanguage"
            value={targetLanguage}
            onChange={(event) => {
              const value = event.target.value;
              if (isLanguageCode(value)) {
                setTargetLanguage(value);
              }
            }}
            disabled={status === "starting" || status === "listening"}
          >
            {LANGUAGE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="actions">
          <button
            type="button"
            onClick={() => void startListening()}
            disabled={!canStart}
          >
            Start listening
          </button>
          <button type="button" onClick={stopListening} disabled={!canStop}>
            Stop
          </button>
          <button type="button" onClick={clearTranscript}>
            Clear
          </button>
        </div>
      </section>

      <section className="mic-state">
        <p>
          Status: <strong>{status}</strong>
        </p>
        <p>
          VAD score: <strong>{vadScore.toFixed(2)}</strong> (speech threshold{" "}
          {VAD_CONFIG.speechThreshold})
        </p>
        <p>
          Silence: <strong>{silenceMs}ms</strong> • Punctuation hint: <strong>{punctuationHint}</strong>
        </p>
        {errorText ? <p className="error">Error: {errorText}</p> : null}
        {interimText ? (
          <p className="interim">
            Interim: <span>{interimText}</span>
          </p>
        ) : null}
      </section>

      <section className="queue-view">
        <h2>Conversation queue</h2>

        {utterances.length === 0 ? (
          <p>No utterance in queue yet.</p>
        ) : (
          <ul>
            {utterances.map((utterance) => (
              <li key={utterance.id} className="utterance-card">
                <header>
                  <span className={`speaker speaker-${utterance.speaker}`}>
                    {utterance.speaker.toUpperCase()}
                  </span>
                  <span className={`state-badge state-${utterance.status}`}>
                    {utterance.status}
                  </span>
                  <time>{toTimeLabel(utterance.timestamp)}</time>
                </header>

                <p className="original">
                  {utterance.originalText || "(waiting for speech)"}
                </p>

                <p className="translated">
                  {utterance.status === "failed"
                    ? "(missed)"
                    : utterance.translatedText || "(translating...)"}
                </p>

                <footer>
                  <span>{utterance.sourceLang}</span>
                  <span>→</span>
                  <span>{utterance.targetLang}</span>
                  <span className="confidence">
                    {(utterance.confidence * 100).toFixed(1)}%
                  </span>
                </footer>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

export default App;
