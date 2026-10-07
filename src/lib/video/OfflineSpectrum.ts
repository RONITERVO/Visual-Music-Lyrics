// The same 1024-point Blackman FFT, dB range and smoothing settings as playback.
// Audio is decoded once; rendering samples it by media time, without playing it.
export class OfflineSpectrum {
  readonly frequency = new Uint8Array(512);
  readonly waveform = new Uint8Array(1024);
  private readonly real = new Float64Array(1024);
  private readonly imaginary = new Float64Array(1024);
  private readonly smoothed = new Float64Array(512);
  private readonly window = Float64Array.from({ length: 1024 }, (_, i) => .42 - .5 * Math.cos(2 * Math.PI * i / 1024) + .08 * Math.cos(4 * Math.PI * i / 1024));
  constructor(private readonly channels: Float32Array[], private readonly sampleRate: number) {}

  at(seconds: number) {
    const end = Math.floor(seconds * this.sampleRate);
    const { real, imaginary } = this;
    for (let i = 0; i < 1024; i++) {
      const position = end - 1024 + i;
      let value = 0;
      for (const channel of this.channels) value += channel[position] ?? 0;
      value /= this.channels.length;
      this.waveform[i] = Math.max(0, Math.min(255, Math.floor((value + 1) * 128)));
      real[i] = value * this.window[i]; imaginary[i] = 0;
    }
    for (let i = 1, j = 0; i < 1024; i++) {
      let bit = 512;
      while (j & bit) { j ^= bit; bit >>= 1; }
      j ^= bit;
      if (i < j) { const value = real[i]; real[i] = real[j]; real[j] = value; }
    }
    for (let length = 2; length <= 1024; length *= 2) {
      const angle = -2 * Math.PI / length, cosine = Math.cos(angle), sine = Math.sin(angle);
      for (let offset = 0; offset < 1024; offset += length) {
        let wr = 1, wi = 0;
        for (let k = 0; k < length / 2; k++) {
          const a = offset + k, b = a + length / 2;
          const tr = real[b] * wr - imaginary[b] * wi, ti = real[b] * wi + imaginary[b] * wr;
          real[b] = real[a] - tr; imaginary[b] = imaginary[a] - ti;
          real[a] += tr; imaginary[a] += ti;
          const next = wr * cosine - wi * sine;
          wi = wr * sine + wi * cosine; wr = next;
        }
      }
    }
    for (let i = 0; i < 512; i++) {
      const magnitude = Math.hypot(real[i], imaginary[i]) / 1024;
      this.smoothed[i] = .68 * this.smoothed[i] + .32 * magnitude;
      const db = 20 * Math.log10(Math.max(1e-12, this.smoothed[i]));
      this.frequency[i] = Math.max(0, Math.min(255, Math.floor((db + 92) / 80 * 255)));
    }
  }
  getByteFrequencyData(output: Uint8Array) { output.set(this.frequency); }
  getByteTimeDomainData(output: Uint8Array) { output.set(this.waveform); }
}
