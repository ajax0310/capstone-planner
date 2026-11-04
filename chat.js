/* AI 챗봇 서버 호출. 계약: POST {message, current_conditions, history} → {reply, summary, updated_conditions, source} */
(function (root) {
  'use strict';

  function config() {
    return root.PKNU_CONFIG && typeof root.PKNU_CONFIG === 'object' ? root.PKNU_CONFIG : {};
  }

  function endpoint() {
    const cfg = config();
    const base = String(cfg.chatBase || '').replace(/\/$/, '');
    const path = String(cfg.chatPath || '/api/chat');
    return base + (path.startsWith('/') ? path : '/' + path);
  }

  // file:// 로 연 단일 HTML에는 챗 서버가 없습니다.
  function available() {
    const protocol = root.location && root.location.protocol;
    return protocol === 'http:' || protocol === 'https:';
  }

  async function send({ message, conditions, history = [], signal, timeoutMs } = {}) {
    if (!available()) {
      const error = new Error('AI 서버는 서버로 실행했을 때만 연결됩니다.');
      error.name = 'UnavailableError';
      throw error;
    }
    const cfg = config();
    const limit = timeoutMs || (Number(cfg.requestTimeoutMs) > 0 ? Number(cfg.requestTimeoutMs) : 60000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limit);
    if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
    try {
      const response = await root.fetch(endpoint(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ message, current_conditions: conditions, history }),
        signal: controller.signal
      });
      if (!response.ok) {
        const error = new Error('HTTP ' + response.status);
        error.name = 'HttpError';
        error.status = response.status;
        throw error;
      }
      const data = await response.json();
      if (!data || typeof data !== 'object' || typeof data.reply !== 'string') {
        throw new Error('AI 서버 응답 형식이 올바르지 않습니다.');
      }
      return {
        reply: data.reply,
        summary: typeof data.summary === 'string' && data.summary.trim() ? data.summary.trim() : null,
        updatedConditions: data.updated_conditions && typeof data.updated_conditions === 'object' ? data.updated_conditions : null,
        source: typeof data.source === 'string' && data.source ? data.source : 'server'
      };
    } finally {
      clearTimeout(timer);
    }
  }

  root.ChatAPI = { send, endpoint, available };
  if (typeof module === 'object' && module.exports) module.exports = root.ChatAPI;
})(typeof window !== 'undefined' ? window : globalThis);
