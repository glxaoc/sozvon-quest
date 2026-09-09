// AudioWorklet: float32 → int16, пачками по ~100 мс (1600 сэмплов при 16 кГц), плюс RMS для индикатора.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(1600);
    this.n = 0;
    this.sq = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      let s = ch[i];
      if (s > 1) s = 1; else if (s < -1) s = -1;
      this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      this.sq += s * s;
      if (this.n === this.buf.length) {
        const out = this.buf.slice();
        this.port.postMessage({ pcm: out.buffer, rms: Math.sqrt(this.sq / this.n) }, [out.buffer]);
        this.n = 0; this.sq = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
