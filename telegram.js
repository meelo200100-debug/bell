'use strict';

const { EventEmitter } = require('events');

class TelegramBot extends EventEmitter {
  constructor(token, options = {}) {
    super();
    if (!token) throw new Error('Telegram token is required');
    this.token = token;
    this.apiBase = `https://api.telegram.org/bot${token}`;
    this.offset = 0;
    this.running = false;
    this.abortController = null;
    if (options.polling) this.startPolling().catch(() => {});
  }

  async call(method, payload = {}, timeoutMs = 30000, externalSignal = null) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const abortFromParent = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener('abort', abortFromParent, { once: true });
    }
    try {
      const response = await fetch(`${this.apiBase}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) {
        const error = new Error(`ETELEGRAM: ${data.error_code || response.status} ${data.description || response.statusText}`);
        error.response = { body: data };
        throw error;
      }
      return data.result;
    } finally {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', abortFromParent);
    }
  }

  sendMessage(chatId, text, options = {}) {
    return this.call('sendMessage', { chat_id: chatId, text, ...options });
  }

  onText(regexp, callback) {
    this.on('message', msg => {
      const text = String(msg.text || '');
      const match = regexp.exec(text);
      if (match) callback(msg, match);
      if (regexp.global || regexp.sticky) regexp.lastIndex = 0;
    });
  }

  async startPolling() {
    if (this.running) return;
    this.running = true;
    while (this.running) {
      try {
        this.abortController = new AbortController();
        const result = await this.call('getUpdates', {
          offset: this.offset,
          timeout: 25,
          allowed_updates: ['message'],
        }, 35000, this.abortController.signal);
        for (const update of result || []) {
          this.offset = Math.max(this.offset, Number(update.update_id || 0) + 1);
          if (update.message) this.emit('message', update.message);
        }
      } catch (error) {
        if (!this.running) break;
        this.emit('polling_error', error);
        await new Promise(resolve => setTimeout(resolve, 2000));
      } finally {
        this.abortController = null;
      }
    }
  }

  async stopPolling() {
    this.running = false;
    if (this.abortController) this.abortController.abort();
  }
}

module.exports = TelegramBot;
