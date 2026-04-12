/**
 * AudioWorklet processor that captures audio, downsamples to 16kHz,
 * and converts to 16-bit PCM for Gemini Live API.
 *
 * Must be loaded via: audioContext.audioWorklet.addModule('pcm-worklet.js')
 */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(0);
    // Accumulate samples until we have ~25ms worth at 16kHz = 400 samples
    this._chunkSize = 400;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) {
      return true;
    }

    // Take first channel (mono)
    const channelData = input[0];

    // Downsample from native rate (usually 48kHz) to 16kHz
    const ratio = sampleRate / 16000;
    const outputLength = Math.floor(channelData.length / ratio);
    const downsampled = new Float32Array(outputLength);

    for (let i = 0; i < outputLength; i++) {
      const srcIndex = i * ratio;
      const lo = Math.floor(srcIndex);
      const hi = Math.min(lo + 1, channelData.length - 1);
      const frac = srcIndex - lo;
      downsampled[i] = channelData[lo] * (1 - frac) + channelData[hi] * frac;
    }

    // Append to buffer
    const newBuffer = new Float32Array(this._buffer.length + downsampled.length);
    newBuffer.set(this._buffer);
    newBuffer.set(downsampled, this._buffer.length);
    this._buffer = newBuffer;

    // Emit chunks when buffer is large enough
    while (this._buffer.length >= this._chunkSize) {
      const chunk = this._buffer.slice(0, this._chunkSize);
      this._buffer = this._buffer.slice(this._chunkSize);

      // Convert Float32 to Int16 PCM
      const pcm = new Int16Array(chunk.length);
      for (let i = 0; i < chunk.length; i++) {
        const clamped = Math.max(-1, Math.min(1, chunk[i]));
        pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      }

      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }

    return true;
  }
}

registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
