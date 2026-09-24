'use strict';
const { MockStt } = require('./mock');
const { AitunnelChunkedStt } = require('./aitunnel-chunked');
const { YandexStreamingStt } = require('./yandex');
const { LocalToneStt } = require('./local-tone');

function createStt(provider, opts) {
  switch (provider) {
    case 'yandex': return new YandexStreamingStt(opts);
    case 'local': return new LocalToneStt(opts);
    case 'mock': return new MockStt(opts);
    case 'nexara': return new AitunnelChunkedStt({
      ...opts,
      backend: { name: 'nexara', baseUrl: opts.config.NEXARA_BASE_URL, apiKey: opts.config.NEXARA_API_KEY, model: opts.config.NEXARA_MODEL || 'nexara-ru' },
      vad: { hangMs: 500 }, // Nexara отвечает быстро — паузу для нарезки можно взять короче
    });
    case 'aitunnel':
    default: return new AitunnelChunkedStt(opts);
  }
}

module.exports = { createStt };
