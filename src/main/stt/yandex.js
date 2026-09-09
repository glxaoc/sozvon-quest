'use strict';
// Yandex SpeechKit, streaming API v3 (gRPC, bidirectional). Настоящий стриминг: partial ~300–500 мс.
// Ограничение сервиса: одна сессия ≤ 5 минут → переоткрываем стрим каждые 4.5 минуты.
// Авторизация: API-ключ сервисного аккаунта (роль ai.speechkit-stt.user). x-folder-id для API-ключа не нужен,
// но если задан — отправляем.
const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const { SttProvider } = require('./base');

const PROTO_DIR = path.join(__dirname, '..', '..', '..', 'proto');
const HOST = 'stt.api.cloud.yandex.net:443';
const SOFT_ROTATE_MS = 4 * 60 * 1000;   // после этого ждём паузу в речи, чтобы не резать фразу
const HARD_ROTATE_MS = 4.75 * 60 * 1000; // жёсткий предел (лимит сервиса 5 мин)

let _pkg = null;
function loadPkg() {
  if (_pkg) return _pkg;
  const def = protoLoader.loadSync('yandex/cloud/ai/stt/v3/stt_service.proto', {
    includeDirs: [PROTO_DIR], keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true,
  });
  _pkg = grpc.loadPackageDefinition(def).speechkit.stt.v3;
  return _pkg;
}

class YandexStreamingStt extends SttProvider {
  constructor(opts) {
    super(opts);
    this.call = null;
    this.client = null;
    this.timeOffset = 0;   // секунд, накопленных до текущего стрима (для сквозных таймстампов)
    this.streamStartedAt = 0;
    this.sentMs = 0;       // сколько аудио отправили в текущий стрим
    this.reconnectTimer = null;
    this.backoff = 1000;
  }

  start() {
    super.start();
    if (!this.config.YANDEX_API_KEY) {
      this.status('error', 'нет YANDEX_API_KEY');
      return;
    }
    const Recognizer = loadPkg().Recognizer;
    this.client = new Recognizer(HOST, grpc.credentials.createSsl());
    this._open();
  }

  _open() {
    if (!this.running) return;
    this.status('connecting');
    const md = new grpc.Metadata();
    md.set('authorization', `Api-Key ${this.config.YANDEX_API_KEY}`);
    if (this.config.YANDEX_FOLDER_ID) md.set('x-folder-id', this.config.YANDEX_FOLDER_ID);
    const call = this.client.RecognizeStreaming(md);
    this.call = call;
    this.timeOffset += this.sentMs / 1000;
    this.sentMs = 0;
    this.streamStartedAt = Date.now();

    call.write({
      session_options: {
        recognition_model: {
          model: 'general',
          audio_format: { raw_audio: { audio_encoding: 'LINEAR16_PCM', sample_rate_hertz: 16000, audio_channel_count: 1 } },
          text_normalization: { text_normalization: 'TEXT_NORMALIZATION_ENABLED', profanity_filter: false, literature_text: true },
          language_restriction: { restriction_type: 'WHITELIST', language_code: ['ru-RU'] },
          audio_processing_type: 'REAL_TIME',
        },
        eou_classifier: { default_classifier: { type: 'DEFAULT', max_pause_between_words_hint_ms: 800 } },
      },
    });

    let lastFinalIndex = -1;
    call.on('data', (resp) => {
      const off = this.timeOffset;
      if (resp.partial && resp.partial.alternatives && resp.partial.alternatives.length) {
        const text = resp.partial.alternatives[0].text;
        if (text) this.emit('partial', { channel: this.channel, text, t: off + (resp.audio_cursors?.partial_time_ms || 0) / 1000 });
        this.status('speech');
      } else if (resp.final && resp.final.alternatives && resp.final.alternatives.length) {
        const alt = resp.final.alternatives[0];
        lastFinalIndex = resp.audio_cursors?.final_index ?? lastFinalIndex + 1;
        if (alt.text && !SttProvider.looksLikeHallucination(alt.text)) {
          this.emit('final', {
            channel: this.channel, text: alt.text,
            t0: off + (alt.start_time_ms || 0) / 1000, t1: off + (alt.end_time_ms || resp.audio_cursors?.final_time_ms || 0) / 1000,
            finalIndex: lastFinalIndex,
          });
        }
        this.status('listening');
      } else if (resp.final_refinement && resp.final_refinement.normalized_text) {
        const alt = resp.final_refinement.normalized_text.alternatives?.[0];
        if (alt && alt.text) {
          this.emit('refine', { channel: this.channel, text: alt.text, finalIndex: resp.final_refinement.final_index });
        }
      } else if (resp.status_code && resp.status_code.code_type === 'CLOSED') {
        this.log('yandex stream closed by server');
      }
    });
    call.on('error', (err) => {
      if (!this.running) return;
      this.log('yandex grpc error', err.code, err.details || err.message);
      this.status('error', err.details || err.message);
      this._scheduleReopen(this.backoff);
      this.backoff = Math.min(this.backoff * 2, 15000);
    });
    call.on('end', () => {
      if (this.running && this.call === call) this._scheduleReopen(200);
    });
    call.on('status', () => { this.backoff = 1000; });
    this.status('listening', 'yandex v3');

    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this._rotate(), HARD_ROTATE_MS);
  }

  _scheduleReopen(ms) {
    clearTimeout(this.reconnectTimer);
    this.call = null;
    this.reconnectTimer = setTimeout(() => this._open(), ms);
  }

  // Плановая ротация стрима до лимита 5 минут
  _rotate() {
    const old = this.call;
    this.call = null;
    if (old) { try { old.end(); } catch (e) { /* ignore */ } }
    this._open();
  }

  push(pcm) {
    if (!this.running || !this.call) return;
    this.sentMs += pcm.length / 2 / 16;
    try { this.call.write({ chunk: { data: pcm } }); } catch (e) { this.log('yandex write failed', e.message); }
    // мягкая ротация: после 4 минут ждём тихий чанк, чтобы не разрезать фразу
    if (Date.now() - this.streamStartedAt > SOFT_ROTATE_MS && this._isQuiet(pcm)) this._rotate();
  }

  _isQuiet(pcm) {
    let sum = 0; const n = pcm.length / 2;
    for (let i = 0; i < pcm.length; i += 2) { const v = pcm.readInt16LE(i); sum += v * v; }
    return Math.sqrt(sum / n) < 300;
  }

  stop() {
    super.stop();
    clearTimeout(this.reconnectTimer);
    if (this.call) { try { this.call.end(); } catch (e) { /* ignore */ } this.call = null; }
    if (this.client) { try { this.client.close(); } catch (e) { /* ignore */ } this.client = null; }
  }
}

module.exports = { YandexStreamingStt };
