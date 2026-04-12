import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { desktopCapturer } from "electron";
import { AUDIO_CONFIG } from "@realtime/shared";

export type SystemAudioCallback = (base64Pcm: string) => void;

export interface SystemAudioCapture {
  stop: () => void;
}

// ── Linux: PulseAudio/PipeWire via parec ──

function getLinuxMonitorSource(): string | null {
  try {
    const defaultSink = execFileSync("pactl", ["get-default-sink"], {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();

    if (!defaultSink) return null;

    const monitorSource = `${defaultSink}.monitor`;
    console.log(`[SystemAudio] Found monitor source: ${monitorSource}`);
    return monitorSource;
  } catch (err) {
    console.error(
      "[SystemAudio] Failed to get PulseAudio monitor source:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

function startLinuxCapture(
  onChunk: SystemAudioCallback,
): SystemAudioCapture | null {
  const monitorSource = getLinuxMonitorSource();
  if (!monitorSource) {
    console.warn("[SystemAudio] No monitor source found");
    return null;
  }

  const proc: ChildProcess = spawn("parec", [
    `--device=${monitorSource}`,
    "--format=s16le",
    `--rate=${AUDIO_CONFIG.sampleRate}`,
    "--channels=1",
    "--latency-msec=10",
  ]);

  if (!proc.stdout) {
    console.error("[SystemAudio] parec has no stdout");
    proc.kill();
    return null;
  }

  console.log(`[SystemAudio] parec started (pid ${proc.pid})`);

  // Send data as it arrives — no extra buffering delay
  proc.stdout.on("data", (data: Buffer) => {
    onChunk(data.toString("base64"));
  });

  proc.stderr?.on("data", (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg) console.error(`[SystemAudio] parec stderr: ${msg}`);
  });

  proc.on("error", (err) => {
    console.error("[SystemAudio] parec error:", err.message);
  });

  proc.on("close", (code) => {
    console.log(`[SystemAudio] parec exited (code ${code})`);
  });

  return {
    stop: () => {
      console.log("[SystemAudio] Stopping parec");
      proc.kill("SIGTERM");
    },
  };
}

// ── macOS / Windows: Electron desktopCapturer ──
// Returns the screen source ID so the renderer can call getUserMedia.
// System audio capture on these platforms must happen in the renderer process
// because getUserMedia is only available there.

export async function getDesktopSourceId(): Promise<string | null> {
  if (process.platform === "linux") return null;

  try {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 0, height: 0 },
    });

    if (sources.length === 0) {
      console.warn("[SystemAudio] No screen sources found");
      return null;
    }

    const sourceId = sources[0]!.id;
    console.log(`[SystemAudio] Desktop source: ${sourceId}`);
    return sourceId;
  } catch (err) {
    console.error("[SystemAudio] desktopCapturer error:", err);
    return null;
  }
}

// ── Entry point ──

/**
 * Start system audio capture (main process, Linux only).
 * For macOS/Windows, use getDesktopSourceId() + renderer-based capture instead.
 */
export function startSystemAudioCapture(
  onChunk: SystemAudioCallback,
): SystemAudioCapture | null {
  if (process.platform === "linux") {
    return startLinuxCapture(onChunk);
  }

  // macOS/Windows handled via renderer — see main.ts IPC flow
  return null;
}
