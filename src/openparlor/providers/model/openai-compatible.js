import { ModelProviderError } from '../../model-provider.js';

function providerError(message, options) {
    return new ModelProviderError(message, options);
}

function responseError(status, text) {
    const detail = typeof text === 'string' && text.trim() ? `: ${text.trim().slice(0, 500)}` : '';
    return providerError(`OpenAI-compatible server returned HTTP ${status}${detail}`, { status });
}

export class OpenAICompatibleModelProvider {
    constructor(config, { fetch: fetchImplementation = globalThis.fetch } = {}) {
        if (!config || typeof config.baseUrl !== 'string' || !config.baseUrl.trim()) {
            throw providerError('OpenAI-compatible base URL is not configured');
        }
        if (typeof fetchImplementation !== 'function') {
            throw providerError('A fetch implementation is required');
        }
        this.config = {
            provider: 'openai-compatible',
            baseUrl: config.baseUrl.replace(/\/+$/, ''),
            model: typeof config.model === 'string' ? config.model : '',
            apiKey: typeof config.apiKey === 'string' ? config.apiKey : '',
        };
        this.fetch = fetchImplementation;
    }

    getInfo() {
        return { provider: this.config.provider, baseUrl: this.config.baseUrl, model: this.config.model };
    }

    async listModels({ signal } = {}) {
        const body = await this.#json('/models', { method: 'GET', signal });
        if (!body || !Array.isArray(body.data) || !body.data.every(model => model && typeof model.id === 'string')) {
            throw providerError('Malformed models response');
        }
        return body.data;
    }

    async chatCompletion(messages, { signal, ...options } = {}) {
        const body = await this.#json('/chat/completions', {
            method: 'POST', signal, body: JSON.stringify(this.#chatBody(messages, false, options)),
        });
        if (!body || !Array.isArray(body.choices)) {
            throw providerError('Malformed chat completion response');
        }
        return body;
    }

    async streamChatCompletion(messages, { signal, ...options } = {}) {
        const response = await this.#request('/chat/completions', {
            method: 'POST', signal, body: JSON.stringify(this.#chatBody(messages, true, options)),
        });
        if (!response.body) throw providerError('Malformed streaming chat response');
        return response.body;
    }

    #chatBody(messages, stream, options) {
        if (!this.config.model) throw providerError('Model is not configured');
        if (!Array.isArray(messages)) throw providerError('Chat messages must be an array');
        return { model: this.config.model, messages, stream, ...options };
    }

    async #json(path, options) {
        const response = await this.#request(path, options);
        try { return await response.json(); } catch (cause) { throw providerError('Invalid JSON response from OpenAI-compatible server', { cause }); }
    }

    async #request(path, options) {
        const headers = { Accept: 'application/json' };
        if (options.body) headers['Content-Type'] = 'application/json';
        if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;
        let response;
        try {
            response = await this.fetch(`${this.config.baseUrl}${path}`, { ...options, headers });
        } catch (cause) {
            throw providerError('Network failure contacting OpenAI-compatible server', { cause });
        }
        if (!response || typeof response.ok !== 'boolean') throw providerError('Malformed response from OpenAI-compatible server');
        if (!response.ok) {
            let text = '';
            try { text = await response.text(); } catch { /* ignore unreadable error response */ }
            throw responseError(response.status, text);
        }
        return response;
    }
}
