'use strict';
// PCM16 mono → WAV (Buffer). И обратное чтение простого WAV для тестов.

function pcm16ToWav(pcm, sampleRate = 16000) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// Возвращает { sampleRate, channels, pcm: Buffer (int16 interleaved) }
function readWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not a RIFF file');
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(buf.length, body + size));
    }
    off = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('wav: no fmt/data chunk');
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error('wav: only PCM16 supported');
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, pcm: data };
}

// Грубый ресемплинг + сведение в моно (для тестовых файлов, не для рантайма)
function toMono16k(pcm, sampleRate, channels) {
  const n = Math.floor(pcm.length / 2 / channels);
  const mono = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < channels; c++) s += pcm.readInt16LE((i * channels + c) * 2);
    mono[i] = s / channels;
  }
  if (sampleRate === 16000) return Buffer.from(mono.buffer);
  const ratio = sampleRate / 16000;
  const m = Math.floor(n / ratio);
  const out = new Int16Array(m);
  for (let i = 0; i < m; i++) {
    const src = i * ratio;
    const a = Math.floor(src), b = Math.min(a + 1, n - 1), t = src - a;
    out[i] = mono[a] * (1 - t) + mono[b] * t;
  }
  return Buffer.from(out.buffer);
}

module.exports = { pcm16ToWav, readWav, toMono16k };
