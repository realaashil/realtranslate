import { AUDIO_CONFIG } from "@realtime/shared";

/**
 * Downsample Float32 audio from a source sample rate to the target 16kHz.
 * Uses simple linear interpolation.
 */
export function downsampleFloat32(
  input: Float32Array,
  inputSampleRate: number,
): Float32Array {
  if (inputSampleRate === AUDIO_CONFIG.sampleRate) {
    return input;
  }

  const ratio = inputSampleRate / AUDIO_CONFIG.sampleRate;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const srcIndex = i * ratio;
    const lo = Math.floor(srcIndex);
    const hi = Math.min(lo + 1, input.length - 1);
    const frac = srcIndex - lo;
    output[i] = input[lo]! * (1 - frac) + input[hi]! * frac;
  }

  return output;
}

/**
 * Convert Float32 audio samples [-1, 1] to 16-bit PCM little-endian Int16Array.
 */
export function float32ToInt16(samples: Float32Array): Int16Array {
  const output = new Int16Array(samples.length);

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    output[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }

  return output;
}

/**
 * Convert Float32 audio to 16-bit PCM at 16kHz, returned as a Buffer.
 */
export function encodeFloat32ToPcm16(
  samples: Float32Array,
  inputSampleRate: number,
): Buffer {
  const downsampled = downsampleFloat32(samples, inputSampleRate);
  const int16 = float32ToInt16(downsampled);
  return Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength);
}

/**
 * Encode a PCM buffer to base64 for Gemini Live API transport.
 */
export function pcmToBase64(pcm: Buffer): string {
  return pcm.toString("base64");
}

/**
 * Full pipeline: Float32 audio → downsampled → Int16 PCM → base64.
 */
export function encodeAudioChunk(
  samples: Float32Array,
  inputSampleRate: number,
): string {
  const pcm = encodeFloat32ToPcm16(samples, inputSampleRate);
  return pcmToBase64(pcm);
}
