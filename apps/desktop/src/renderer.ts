import "./index.css";

// ── Types (must match preload.ts) ──

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

interface OverlayBounds { x: number; y: number; width: number; height: number }
interface PipelineUtterance {
  id: string; speaker: Speaker; timestamp: number; status: UtteranceStatus;
  originalText: string; translatedText: string; sourceLang: string; targetLang: string;
}
interface AuthSnapshot { status: AuthStatus; email: string | null; userId: string | null; error: string | null }
interface PipelineSnapshot {
  isRunning: boolean; youSessionState: GeminiSessionState; themSessionState: GeminiSessionState;
  meetingLifecycle: MeetingLifecycle; meetingScore: number; meetingDecision: DetectionDecision;
  autoStopSecondsRemaining: number | null; utterances: PipelineUtterance[];
  dailyRemainingMs: number | null; error: string | null; activeLanguagePair: string; auth: AuthSnapshot;
}
interface LanguageSettings { youSource: string; youTarget: string; themSource: string; themTarget: string }
interface AppSettings { tokenServiceUrl: string; language: LanguageSettings }

// ── Language Options ──

const LANGUAGES: { code: string; flag: string; name: string }[] = [
  { code: "en-US", flag: "\u{1F1FA}\u{1F1F8}", name: "English" },
  { code: "hi-IN", flag: "\u{1F1EE}\u{1F1F3}", name: "Hindi" },
  { code: "es-ES", flag: "\u{1F1EA}\u{1F1F8}", name: "Spanish" },
  { code: "fr-FR", flag: "\u{1F1EB}\u{1F1F7}", name: "French" },
  { code: "de-DE", flag: "\u{1F1E9}\u{1F1EA}", name: "German" },
  { code: "pt-BR", flag: "\u{1F1E7}\u{1F1F7}", name: "Portuguese" },
  { code: "it-IT", flag: "\u{1F1EE}\u{1F1F9}", name: "Italian" },
  { code: "ja-JP", flag: "\u{1F1EF}\u{1F1F5}", name: "Japanese" },
  { code: "ko-KR", flag: "\u{1F1F0}\u{1F1F7}", name: "Korean" },
  { code: "zh-CN", flag: "\u{1F1E8}\u{1F1F3}", name: "Chinese" },
  { code: "ar-SA", flag: "\u{1F1F8}\u{1F1E6}", name: "Arabic" },
  { code: "ru-RU", flag: "\u{1F1F7}\u{1F1FA}", name: "Russian" },
  { code: "nl-NL", flag: "\u{1F1F3}\u{1F1F1}", name: "Dutch" },
  { code: "sv-SE", flag: "\u{1F1F8}\u{1F1EA}", name: "Swedish" },
  { code: "pl-PL", flag: "\u{1F1F5}\u{1F1F1}", name: "Polish" },
  { code: "tr-TR", flag: "\u{1F1F9}\u{1F1F7}", name: "Turkish" },
  { code: "vi-VN", flag: "\u{1F1FB}\u{1F1F3}", name: "Vietnamese" },
  { code: "th-TH", flag: "\u{1F1F9}\u{1F1ED}", name: "Thai" },
  { code: "id-ID", flag: "\u{1F1EE}\u{1F1E9}", name: "Indonesian" },
  { code: "bn-IN", flag: "\u{1F1EE}\u{1F1F3}", name: "Bengali" },
  { code: "ta-IN", flag: "\u{1F1EE}\u{1F1F3}", name: "Tamil" },
  { code: "te-IN", flag: "\u{1F1EE}\u{1F1F3}", name: "Telugu" },
  { code: "mr-IN", flag: "\u{1F1EE}\u{1F1F3}", name: "Marathi" },
  { code: "gu-IN", flag: "\u{1F1EE}\u{1F1F3}", name: "Gujarati" },
  { code: "pa-IN", flag: "\u{1F1EE}\u{1F1F3}", name: "Punjabi" },
  { code: "ur-PK", flag: "\u{1F1F5}\u{1F1F0}", name: "Urdu" },
  { code: "uk-UA", flag: "\u{1F1FA}\u{1F1E6}", name: "Ukrainian" },
];

const makeLangSelect = (id: string, selected: string): HTMLSelectElement => {
  const sel = el("select", { id, class: "lang-select" }) as unknown as HTMLSelectElement;
  for (const lang of LANGUAGES) {
    const opt = document.createElement("option");
    opt.value = lang.code;
    opt.textContent = `${lang.flag}  ${lang.name}`;
    if (lang.code === selected) opt.selected = true;
    sel.append(opt);
  }
  return sel;
};

// ── Audio Capture State ──

let micStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let workletNode: AudioWorkletNode | null = null;
let systemStream: MediaStream | null = null;
let systemAudioCtx: AudioContext | null = null;
let systemWorkletNode: AudioWorkletNode | null = null;
let settingsVisible = false;
let viewMode: "feed" | "subtitle" = "feed";
let micMuted = false;
let systemMuted = false;

// ── DOM Construction ──

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string>,
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") e.className = v;
      else e.setAttribute(k, v);
    }
  }
  for (const c of children) {
    e.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return e;
};

// Header
const brandSpan = el("span", { class: "brand" }, "RealTranslate");
const langBadge = el("span", { class: "lang-badge", id: "lang-badge" }, "EN → HI");
const dailyMeta = el("span", { class: "header-meta", id: "daily-meta" });
const toggleBtn = el("button", { id: "toggle-btn", type: "button" }, "Hide");
const settingsBtn = el("button", { id: "settings-btn", type: "button" }, "Settings");
const pipelineBtn = el("button", { id: "pipeline-btn", type: "button" }, "Start");
const clearBtn = el("button", { id: "clear-btn", type: "button" }, "Clear");
const viewModeBtn = el("button", { id: "view-mode-btn", type: "button" }, "Subtitle");
const headerSignOutBtn = el("button", { id: "header-signout", type: "button", style: "display:none" }, "Sign Out");

const header = el("header", { class: "overlay-header" },
  el("div", { class: "header-left" }, brandSpan, langBadge),
  el("div", { class: "header-right" },
    dailyMeta,
    el("div", { class: "header-actions" }, toggleBtn, viewModeBtn, settingsBtn, pipelineBtn, clearBtn, headerSignOutBtn),
  ),
);

// Auth panel — login / sign-up dual view
let authMode: "login" | "signup" = "login";

const authStateChip = el("span", { id: "auth-state" });
const authUserSpan = el("span", {}, "Not signed in");
const authErrorP = el("p", { class: "auth-error", id: "auth-error" });

// Login form
const loginEmailInput = el("input", { id: "login-email", type: "email", placeholder: "you@example.com", required: "" });
const loginPassInput = el("input", { id: "login-password", type: "password", placeholder: "Password" });
const loginSubmitBtn = el("button", { type: "submit", class: "btn-primary" }, "Login");
const authSignOutBtn = el("button", { id: "auth-signout", type: "button", class: "btn-secondary" }, "Sign out");
const loginToggleLink = el("a", { href: "#", class: "auth-toggle-link" }, "Sign Up");
const loginForm = el("form", { id: "login-form", class: "auth-form" },
  el("div", { class: "auth-field" },
    el("label", { for: "login-email" }, "Email"),
    loginEmailInput,
  ),
  el("div", { class: "auth-field" },
    el("label", { for: "login-password" }, "Password"),
    loginPassInput,
  ),
  el("div", { class: "auth-actions" }, loginSubmitBtn),
  authErrorP,
  el("p", { class: "auth-footer-text" }, "Don't have an account? ", loginToggleLink),
);

// Sign-up form
const signupNameInput = el("input", { id: "signup-name", type: "text", placeholder: "Alex Mercer" });
const signupEmailInput = el("input", { id: "signup-email", type: "email", placeholder: "you@example.com", required: "" });
const signupPassInput = el("input", { id: "signup-password", type: "password", placeholder: "Password", required: "" });
const signupConfirmInput = el("input", { id: "signup-confirm", type: "password", placeholder: "Re-enter password", required: "" });
const signupSubmitBtn = el("button", { type: "submit", class: "btn-primary" }, "Sign Up");
const signupErrorP = el("p", { class: "auth-error", id: "signup-error" });
const signupToggleLink = el("a", { href: "#", class: "auth-toggle-link" }, "Login");
const signupForm = el("form", { id: "signup-form", class: "auth-form" },
  el("div", { class: "auth-field" },
    el("label", { for: "signup-name" }, "Full Name"),
    signupNameInput,
  ),
  el("div", { class: "auth-field" },
    el("label", { for: "signup-email" }, "Email Address"),
    signupEmailInput,
  ),
  el("div", { class: "auth-field" },
    el("label", { for: "signup-password" }, "Password"),
    signupPassInput,
  ),
  el("div", { class: "auth-field" },
    el("label", { for: "signup-confirm" }, "Confirm Password"),
    signupConfirmInput,
  ),
  el("div", { class: "auth-actions" }, signupSubmitBtn),
  signupErrorP,
  el("p", { class: "auth-footer-text" }, "Already have an account? ", signupToggleLink),
);

// Auth header + container
const authHeaderTitle = el("p", {}, "Welcome Back");
const loginContainer = el("div", { id: "login-container" }, loginForm);
const signupContainer = el("div", { id: "signup-container", style: "display:none" }, signupForm);

const authPanel = el("section", { class: "auth-panel", id: "auth-panel", style: "display:none" },
  el("div", { class: "auth-header" },
    el("h2", {}, "REALTRANSLATE"),
    authHeaderTitle,
  ),
  loginContainer,
  signupContainer,
);

const showAuthMode = (mode: "login" | "signup"): void => {
  authMode = mode;
  authErrorP.textContent = "";
  signupErrorP.textContent = "";
  if (mode === "login") {
    loginContainer.style.display = "";
    signupContainer.style.display = "none";
    authHeaderTitle.textContent = "Welcome Back";
  } else {
    loginContainer.style.display = "none";
    signupContainer.style.display = "";
    authHeaderTitle.textContent = "Create Account";
  }
};

// Status bar
const youStatusDot = el("span", { class: "status-dot", id: "you-dot" });
const themStatusDot = el("span", { class: "status-dot", id: "them-dot" });
const micPillLabel = el("span", {}, "My mic");
const systemPillLabel = el("span", {}, "Speaker");
const micPill = el("span", { class: "status-pill stream-toggle", id: "mic-pill" }, youStatusDot, micPillLabel);
const systemPill = el("span", { class: "status-pill stream-toggle", id: "system-pill" }, themStatusDot, systemPillLabel);
const meetingPill = el("span", { class: "status-pill", id: "meeting-pill" });
const errorPill = el("span", { class: "status-pill", id: "error-pill" });

const statusBar = el("div", { class: "status-bar" },
  micPill,
  systemPill,
  meetingPill,
  errorPill,
);

// Feed
const feedSection = el("section", { class: "feed", id: "utterance-list" });
const feedAnchor = el("div", { class: "feed-anchor" });
feedSection.append(feedAnchor);

// Subtitle view — shows only the latest utterance per speaker
const subtitleYouText = el("p", { class: "subtitle-text you" });
const subtitleYouOriginal = el("p", { class: "subtitle-original you" });
const subtitleThemText = el("p", { class: "subtitle-text them" });
const subtitleThemOriginal = el("p", { class: "subtitle-original them" });
const subtitleSection = el("section", { class: "subtitle-view", id: "subtitle-view", style: "display:none" },
  el("div", { class: "subtitle-row you" }, subtitleYouText, subtitleYouOriginal),
  el("div", { class: "subtitle-row them" }, subtitleThemText, subtitleThemOriginal),
);

// Bottom nav
const navListening = el("div", { class: "nav-item inactive", id: "nav-listening" },
  el("span", { class: "nav-item-label" }, "Listening"),
);
const navProcessing = el("div", { class: "nav-item inactive", id: "nav-processing" },
  el("span", { class: "nav-item-label" }, "Processing"),
);
const navTranslating = el("div", { class: "nav-item inactive", id: "nav-translating" },
  el("span", { class: "nav-item-label" }, "Translating"),
);
const navReady = el("div", { class: "nav-item inactive", id: "nav-ready" },
  el("span", { class: "nav-item-label" }, "Ready"),
);
const bottomNav = el("nav", { class: "bottom-nav" }, navListening, navProcessing, navTranslating, navReady);

// Settings panel
const tokenServiceInput = el("input", { id: "token-service-url", type: "text", placeholder: "http://127.0.0.1:8787" });
const youTargetSelect = makeLangSelect("you-target", "hi-IN");
const themTargetSelect = makeLangSelect("them-target", "en-US");
const saveSettingsBtn = el("button", { id: "save-settings", type: "button", class: "btn-secondary" }, "Save");
const settingsStatusP = el("p", { class: "settings-status", id: "settings-status" });

const settingsPanel = el("section", { class: "settings-panel", id: "settings-panel" },
  el("div", { class: "settings-row" },
    el("div", { class: "field" }, el("label", {}, "Translate me into"), youTargetSelect as unknown as HTMLElement),
    el("div", { class: "field" }, el("label", {}, "Translate speaker into"), themTargetSelect as unknown as HTMLElement),
  ),
  el("div", { class: "settings-footer" }, saveSettingsBtn, settingsStatusP),
);

// Footer
const footerNotice = el("span", { id: "status-notice" }, "Ready to translate");
const footerBounds = el("span", { id: "bounds" });
const footerEl = el("footer", { class: "overlay-footer" }, footerNotice, footerBounds);

// Assemble
const root = el("main", { class: "overlay-root" },
  header, authPanel, statusBar, settingsPanel, feedSection, subtitleSection, bottomNav, footerEl,
);
document.body.append(root);

// ── Helpers ──

const formatTime = (ts: number): string =>
  new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const formatRemaining = (ms: number | null): string => {
  if (ms === null) return "";
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  if (hours > 0) return `${hours}h ${mins}m remaining`;
  if (mins > 0) return `${mins}m remaining`;
  return "No time remaining";
};

// ── PCM Mic Capture ──

const stopMicCapture = (): void => {
  if (workletNode) { workletNode.disconnect(); workletNode.port.close(); workletNode = null; }
  if (audioContext) { void audioContext.close(); audioContext = null; }
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
};

const startMicCapture = async (): Promise<void> => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const ctx = new AudioContext({ sampleRate: 48000 });
    await ctx.audioWorklet.addModule("pcm-worklet.js");
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, "pcm-capture-processor");
    node.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
      if (micMuted) return;
      const bytes = new Uint8Array(ev.data);
      let bin = "";
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
      void window.gemini.pushMicChunk(btoa(bin));
    };
    source.connect(node);
    micStream = stream; audioContext = ctx; workletNode = node;
  } catch (err) {
    footerNotice.textContent = `Couldn't access microphone: ${err instanceof Error ? err.message : "unknown error"}`;
  }
};

// ── Feed: in-place DOM updates for streaming ──

const feedElements = new Map<string, {
  wrap: HTMLElement;
  translatedP: HTMLElement | null;
  originalP: HTMLElement | null;
  statusIcon: HTMLElement | null;
  lastStatus: UtteranceStatus;
  lastOriginal: string;
  lastTranslated: string;
}>();

const updateFeed = (utterances: PipelineUtterance[], isSignedIn: boolean): void => {
  const recent = utterances.slice(-12);
  const recentIds = new Set(recent.map((u) => u.id));

  // Remove DOM nodes for utterances no longer in the list
  for (const [id, entry] of feedElements) {
    if (!recentIds.has(id)) {
      entry.wrap.remove();
      feedElements.delete(id);
    }
  }

  // Show empty state
  if (recent.length === 0) {
    const msg = isSignedIn ? "Hit Go Live to start translating" : "Sign in to get started";
    const existing = feedSection.querySelector(".empty-state p");
    if (existing) {
      existing.textContent = msg;
    } else {
      feedSection.replaceChildren(
        el("div", { class: "empty-state" }, el("p", {}, msg)),
        feedAnchor,
      );
    }
    return;
  }

  // Remove empty state if present
  const emptyEl = feedSection.querySelector(".empty-state");
  if (emptyEl) emptyEl.remove();

  for (const u of recent) {
    const existing = feedElements.get(u.id);

    if (!existing) {
      // New utterance — create DOM
      const wrap = createUtteranceEl(u);
      wrap.setAttribute("data-id", u.id);
      feedSection.insertBefore(wrap, feedAnchor);
      feedElements.set(u.id, {
        wrap,
        translatedP: wrap.querySelector(".utterance-translated"),
        originalP: wrap.querySelector(".utterance-original"),
        statusIcon: wrap.querySelector(".utterance-status-icon"),
        lastStatus: u.status,
        lastOriginal: u.originalText,
        lastTranslated: u.translatedText,
      });
    } else {
      // Existing utterance — patch text in-place (no DOM rebuild)
      if (u.translatedText !== existing.lastTranslated) {
        if (existing.translatedP) {
          existing.translatedP.textContent = u.translatedText || "...";
        } else if (u.translatedText) {
          const p = el("p", { class: "utterance-translated" }, u.translatedText);
          // Insert before original text
          const origP = existing.wrap.querySelector(".utterance-original");
          if (origP) {
            existing.wrap.insertBefore(p, origP);
          } else {
            const meta = existing.wrap.querySelector(".utterance-meta");
            if (meta) existing.wrap.insertBefore(p, meta);
            else existing.wrap.append(p);
          }
          existing.translatedP = p;
        }
        existing.lastTranslated = u.translatedText;
      }

      if (u.originalText !== existing.lastOriginal) {
        if (existing.originalP) {
          existing.originalP.textContent = u.originalText;
        } else if (u.originalText) {
          const p = el("p", { class: "utterance-original" }, u.originalText);
          const meta = existing.wrap.querySelector(".utterance-meta");
          if (meta) existing.wrap.insertBefore(p, meta);
          else existing.wrap.append(p);
          existing.originalP = p;
        }
        existing.lastOriginal = u.originalText;
      }

      // Update status icon + styling if changed
      if (u.status !== existing.lastStatus) {
        existing.wrap.className = `utterance ${u.speaker}`;

        if (existing.lastStatus === "listening" && u.status !== "listening") {
          const dots = existing.wrap.querySelector(".listening-dots");
          if (dots) dots.remove();
        }

        // Update the status icon
        if (existing.statusIcon) {
          if (u.status === "done") {
            existing.statusIcon.className = "utterance-status-icon done";
            existing.statusIcon.textContent = "\u2713";
          } else if (u.status === "processing") {
            existing.statusIcon.className = "utterance-status-icon processing";
            existing.statusIcon.textContent = "\u25CB";
          } else {
            existing.statusIcon.className = "utterance-status-icon";
            existing.statusIcon.textContent = "";
          }
        }

        existing.lastStatus = u.status;
      }
    }
  }

};

const updateSubtitleView = (utterances: PipelineUtterance[]): void => {
  // Find the latest utterance per speaker (prefer non-done for live feel, fallback to most recent)
  const lastYou = [...utterances].reverse().find((u) => u.speaker === "you");
  const lastThem = [...utterances].reverse().find((u) => u.speaker === "them");

  if (lastYou) {
    subtitleYouText.textContent = lastYou.translatedText || lastYou.originalText || "";
    subtitleYouOriginal.textContent = lastYou.translatedText ? lastYou.originalText : "";
    subtitleYouText.parentElement!.style.display = subtitleYouText.textContent ? "" : "none";
  } else {
    subtitleYouText.parentElement!.style.display = "none";
  }

  if (lastThem) {
    subtitleThemText.textContent = lastThem.translatedText || lastThem.originalText || "";
    subtitleThemOriginal.textContent = lastThem.translatedText ? lastThem.originalText : "";
    subtitleThemText.parentElement!.style.display = subtitleThemText.textContent ? "" : "none";
  } else {
    subtitleThemText.parentElement!.style.display = "none";
  }
};

// ── System Audio Capture (macOS/Windows via desktopCapturer) ──

const stopSystemAudioCapture = (): void => {
  if (systemWorkletNode) { systemWorkletNode.disconnect(); systemWorkletNode.port.close(); systemWorkletNode = null; }
  if (systemAudioCtx) { void systemAudioCtx.close(); systemAudioCtx = null; }
  if (systemStream) { systemStream.getTracks().forEach((t) => t.stop()); systemStream = null; }
};

const startSystemAudioCapture = async (sourceId: string): Promise<void> => {
  stopSystemAudioCapture();
  try {
    // desktopCapturer requires both audio and video constraints
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: sourceId,
        },
      } as unknown as MediaTrackConstraints,
      video: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: sourceId,
        },
      } as unknown as MediaTrackConstraints,
    });

    // Stop video tracks immediately — we only need audio
    stream.getVideoTracks().forEach((t) => t.stop());

    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      console.warn("[SystemAudio] No audio tracks from desktopCapturer");
      return;
    }

    // Create audio-only stream
    const audioStream = new MediaStream(audioTracks);

    const ctx = new AudioContext({ sampleRate: 48000 });
    await ctx.audioWorklet.addModule("pcm-worklet.js");
    const source = ctx.createMediaStreamSource(audioStream);
    const node = new AudioWorkletNode(ctx, "pcm-capture-processor");

    node.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
      if (systemMuted) return;
      const bytes = new Uint8Array(ev.data);
      let bin = "";
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
      void window.gemini.pushSystemChunk(btoa(bin));
    };

    source.connect(node);
    systemStream = audioStream;
    systemAudioCtx = ctx;
    systemWorkletNode = node;
    console.log("[SystemAudio] Renderer capture started");
  } catch (err) {
    console.error("[SystemAudio] Renderer capture failed:", err instanceof Error ? err.message : err);
  }
};

// ── Rendering ──

const createUtteranceEl = (u: PipelineUtterance): HTMLElement => {
  const wrap = el("div", { class: `utterance ${u.speaker}` });

  // Label row
  const label = el("div", { class: "utterance-label" });
  label.append(el("span", { class: "utterance-speaker" }, u.speaker === "you" ? "Me" : "Speaker"));

  if (u.status === "done") {
    const check = el("span", { class: "utterance-status-icon done" }, "\u2713");
    label.append(check);
  } else if (u.status === "processing") {
    const spin = el("span", { class: "utterance-status-icon processing" }, "\u25CB");
    label.append(spin);
  } else if (u.status === "listening") {
    const pulse = el("span", { class: "utterance-status-icon listening" });
    pulse.append(el("span", { class: "pulse-ring-small" }));
    label.append(pulse);
  }
  wrap.append(label);

  // Content
  if (u.status === "listening" && !u.originalText) {
    const dots = el("div", { class: "listening-dots" },
      el("span", {}), el("span", {}), el("span", {}),
    );
    wrap.append(dots);
  } else {
    if (u.translatedText) {
      wrap.append(el("p", { class: "utterance-translated" }, u.translatedText));
    } else if (u.status === "processing") {
      wrap.append(el("p", { class: "utterance-translated" }, "..."));
    }
    if (u.originalText) {
      wrap.append(el("p", { class: "utterance-original" }, u.originalText));
    }
  }

  // Meta
  wrap.append(el("span", { class: "utterance-meta" },
    `${u.sourceLang} → ${u.targetLang} \u00B7 ${formatTime(u.timestamp)}`,
  ));

  return wrap;
};

const setDotState = (dot: HTMLElement, state: GeminiSessionState): void => {
  dot.className = `status-dot ${state === "ready" ? "ready" : state === "connecting" || state === "setup" ? "connecting" : state === "error" ? "error" : ""}`;
};

const updateBottomNav = (utterances: PipelineUtterance[], isRunning: boolean): void => {
  const hasListening = utterances.some((u) => u.status === "listening");
  const hasProcessing = utterances.some((u) => u.status === "processing");
  const hasDone = utterances.some((u) => u.status === "done");

  navListening.className = `nav-item ${hasListening ? "active" : "inactive"}`;
  navProcessing.className = `nav-item ${hasProcessing ? "active processing" : "inactive"}`;
  navTranslating.className = `nav-item ${hasProcessing ? "active" : "inactive"}`;
  navReady.className = `nav-item ${hasDone && !hasProcessing && !hasListening ? "active" : "inactive"}`;

  if (!isRunning) {
    navListening.className = navProcessing.className = navTranslating.className = navReady.className = "nav-item inactive";
  }
};

const renderAuth = (auth: AuthSnapshot): void => {
  if (auth.status === "signed_in") {
    authStateChip.textContent = "";
    authStateChip.style.color = "";
    authUserSpan.textContent = "";
  } else if (auth.status === "signing_in") {
    authStateChip.textContent = "";
    authStateChip.style.color = "";
    authUserSpan.textContent = "";
  } else {
    authStateChip.textContent = "";
    authUserSpan.textContent = "";
  }

  // Show error on whichever form is active
  if (auth.error) {
    if (authMode === "login") authErrorP.textContent = auth.error;
    else signupErrorP.textContent = auth.error;
  }

  const busy = auth.status === "signing_in";
  const signedIn = auth.status === "signed_in";

  // Login form
  loginSubmitBtn.disabled = busy || signedIn;
  authSignOutBtn.disabled = !signedIn;
  loginEmailInput.disabled = busy || signedIn;
  loginPassInput.disabled = busy || signedIn;

  // Signup form
  signupSubmitBtn.disabled = busy || signedIn;
  signupNameInput.disabled = busy || signedIn;
  signupEmailInput.disabled = busy || signedIn;
  signupPassInput.disabled = busy || signedIn;
  signupConfirmInput.disabled = busy || signedIn;

  // Show auth panel only when definitively signed out, hide during sign-in or signed-in
  authPanel.style.display = auth.status === "signed_out" ? "" : "none";
  headerSignOutBtn.style.display = signedIn ? "" : "none";
};

const renderSettings = (settings: AppSettings): void => {
  tokenServiceInput.value = settings.tokenServiceUrl;
  youTargetSelect.value = settings.language.youTarget;
  themTargetSelect.value = settings.language.themTarget;
};

const renderSnapshot = (snap: PipelineSnapshot): void => {
  renderAuth(snap.auth);

  // Header
  langBadge.textContent = snap.activeLanguagePair;
  dailyMeta.textContent = formatRemaining(snap.dailyRemainingMs);
  pipelineBtn.textContent = snap.isRunning ? "Stop" : "Go Live";
  pipelineBtn.className = snap.isRunning ? "active" : "";
  pipelineBtn.disabled = snap.auth.status !== "signed_in";

  // Status bar — reflect mute state
  setDotState(youStatusDot, micMuted ? "disconnected" : snap.youSessionState);
  setDotState(themStatusDot, systemMuted ? "disconnected" : snap.themSessionState);
  micPill.className = `status-pill stream-toggle${micMuted ? " muted" : ""}`;
  micPillLabel.textContent = micMuted ? "Mic muted" : "My mic";
  systemPill.className = `status-pill stream-toggle${systemMuted ? " muted" : ""}`;
  systemPillLabel.textContent = systemMuted ? "Muted" : "Speaker";

  const meetingLabel = snap.meetingLifecycle === "active" ? "Meeting Active" : snap.meetingLifecycle === "prompt" ? "Meeting?" : "";
  meetingPill.textContent = meetingLabel;
  meetingPill.style.display = meetingLabel ? "" : "none";
  if (snap.meetingLifecycle === "active") meetingPill.className = "status-pill highlight";
  else meetingPill.className = "status-pill";

  errorPill.textContent = snap.error ?? "";
  errorPill.style.display = snap.error ? "" : "none";

  // Feed / Subtitle view
  if (viewMode === "feed") {
    updateFeed(snap.utterances, snap.auth.status === "signed_in");
  } else {
    updateSubtitleView(snap.utterances);
  }

  // Bottom nav
  updateBottomNav(snap.utterances, snap.isRunning);
};

// ── Initialization ──

const updateBounds = async (): Promise<void> => {
  const b = await window.overlay.getBounds();
  footerBounds.textContent = `${b.width}x${b.height}`;
};

if (!window.overlay || !window.pipelines || !window.auth || !window.settings || !window.gemini) {
  throw new Error("Preload bridge unavailable.");
}

// ── Event Handlers ──

toggleBtn.addEventListener("click", async () => {
  await window.overlay.toggleVisibility();
  await updateBounds();
});

viewModeBtn.addEventListener("click", () => {
  viewMode = viewMode === "feed" ? "subtitle" : "feed";
  viewModeBtn.textContent = viewMode === "feed" ? "Subtitle" : "Feed";
  viewModeBtn.className = viewMode === "subtitle" ? "active" : "";
  feedSection.style.display = viewMode === "feed" ? "" : "none";
  subtitleSection.style.display = viewMode === "subtitle" ? "" : "none";
  bottomNav.style.display = viewMode === "subtitle" ? "none" : "";
});

micPill.addEventListener("click", async () => {
  micMuted = !micMuted;
  micPill.className = `status-pill stream-toggle${micMuted ? " muted" : ""}`;
  micPillLabel.textContent = micMuted ? "Mic muted" : "My mic";
  if (micMuted) {
    stopMicCapture();
    await window.gemini.muteSpeaker("you");
  } else {
    await window.gemini.unmuteSpeaker("you");
    await startMicCapture();
  }
});

systemPill.addEventListener("click", async () => {
  systemMuted = !systemMuted;
  systemPill.className = `status-pill stream-toggle${systemMuted ? " muted" : ""}`;
  systemPillLabel.textContent = systemMuted ? "Muted" : "Speaker";
  if (systemMuted) {
    stopSystemAudioCapture();
    await window.gemini.muteSpeaker("them");
  } else {
    await window.gemini.unmuteSpeaker("them");
  }
});

settingsBtn.addEventListener("click", () => {
  settingsVisible = !settingsVisible;
  settingsPanel.className = settingsVisible ? "settings-panel visible" : "settings-panel";
  settingsBtn.className = settingsVisible ? "active" : "";
});

pipelineBtn.addEventListener("click", async () => {
  const snap = await window.pipelines.get();
  if (snap.isRunning) {
    stopMicCapture();
    renderSnapshot(await window.pipelines.stop());
  } else {
    const next = await window.pipelines.start();
    renderSnapshot(next);
    if (next.isRunning) await startMicCapture();
  }
});

clearBtn.addEventListener("click", async () => {
  renderSnapshot(await window.pipelines.clear());
});

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  authErrorP.textContent = "";
  const email = loginEmailInput.value.trim();
  const password = loginPassInput.value;
  try {
    await window.auth.signIn({ email, password });
    renderSnapshot(await window.pipelines.get());
  } catch (err) {
    authErrorP.textContent = err instanceof Error ? err.message : "Couldn't sign in, please try again";
  }
});

signupForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  signupErrorP.textContent = "";
  const email = signupEmailInput.value.trim();
  const password = signupPassInput.value;
  const confirm = signupConfirmInput.value;

  if (password !== confirm) {
    signupErrorP.textContent = "Passwords don't match";
    return;
  }
  if (password.length < 6) {
    signupErrorP.textContent = "Password must be at least 6 characters";
    return;
  }

  try {
    await window.auth.signUp({ email, password });
    renderSnapshot(await window.pipelines.get());
  } catch (err) {
    signupErrorP.textContent = err instanceof Error ? err.message : "Couldn't create account, please try again";
  }
});

loginToggleLink.addEventListener("click", (e) => {
  e.preventDefault();
  showAuthMode("signup");
});

signupToggleLink.addEventListener("click", (e) => {
  e.preventDefault();
  showAuthMode("login");
});

authSignOutBtn.addEventListener("click", async () => {
  try {
    stopMicCapture();
    await window.auth.signOut();
    renderSnapshot(await window.pipelines.get());
  } catch (err) {
    authErrorP.textContent = err instanceof Error ? err.message : "Couldn't sign out, please try again";
  }
});

saveSettingsBtn.addEventListener("click", async () => {
  try {
    const [next] = await Promise.all([
      window.settings.updateTokenServiceUrl(tokenServiceInput.value.trim()),
      window.settings.updateLanguage({
        youSource: "auto",
        youTarget: youTargetSelect.value,
        themSource: "auto",
        themTarget: themTargetSelect.value,
      }),
    ]);
    renderSettings(next);
    settingsStatusP.textContent = "Settings saved";
    renderSnapshot(await window.pipelines.get());
  } catch (err) {
    settingsStatusP.textContent = err instanceof Error ? err.message : "Couldn't save settings";
  }
});

headerSignOutBtn.addEventListener("click", async () => {
  try {
    stopMicCapture();
    await window.auth.signOut();
    renderSnapshot(await window.pipelines.get());
  } catch (err) {
    footerNotice.textContent = err instanceof Error ? err.message : "Couldn't sign out";
  }
});

// ── System Audio IPC (macOS/Windows) ──

const unsubSystemStart = window.gemini.onStartSystemAudio((sourceId) => {
  void startSystemAudioCapture(sourceId);
});

const unsubSystemStop = window.gemini.onStopSystemAudio(() => {
  stopSystemAudioCapture();
});

// ── Live Updates ──

const unsubscribe = window.pipelines.onUpdate((snap) => renderSnapshot(snap));

void (async () => {
  await updateBounds();
  renderSettings(await window.settings.get());
  await window.auth.get();
  renderSnapshot(await window.pipelines.get());
})();

const refreshTimer = window.setInterval(() => void updateBounds(), 5000);

window.addEventListener("beforeunload", () => {
  stopMicCapture();
  stopSystemAudioCapture();
  window.clearInterval(refreshTimer);
  unsubscribe();
  unsubSystemStart();
  unsubSystemStop();
});
