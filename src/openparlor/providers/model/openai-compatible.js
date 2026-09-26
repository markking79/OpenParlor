import { ModelProviderError } from '../../model-provider.js';

function providerError(message, options) {
    return new ModelProviderError(message, options);
}

function responseError(status, text) {
    const detail = typeof text === 'string' && text.trim() ? `: ${text.trim().slice(0, 500)}` : '';
    return providerError(`OpenAI-compatible server returned HTTP ${status}${detail}`, { status });
}

// Statuses a server uses to say "this request body contains something I do not
// accept". Only these trigger the thinking-control fallback below.
const UNSUPPORTED_REQUEST_STATUSES = new Set([400, 415, 422, 501]);

// Base URLs that have rejected the chat-template thinking control. The
// provider is constructed per request, so the verdict is remembered per
// SERVER rather than per instance: a deployment that does not understand the
// field pays for one rejected request, never one per turn.
const thinkingControlUnsupportedServers = new Set();

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

    async chatCompletion(messages, { signal, disableThinking, ...options } = {}) {
        const response = await this.#sendChat(messages, false, options, signal, disableThinking);
        let body;
        try {
            body = await response.json();
        } catch (cause) {
            throw providerError('Invalid JSON response from OpenAI-compatible server', { cause });
        }
        if (!body || !Array.isArray(body.choices)) {
            throw providerError('Malformed chat completion response');
        }
        return body;
    }

    async streamChatCompletion(messages, { signal, disableThinking, ...options } = {}) {
        const response = await this.#sendChat(messages, true, options, signal, disableThinking);
        if (!response.body) throw providerError('Malformed streaming chat response');
        return response.body;
    }

    /**
     * Whether this request should carry the chat-template thinking control.
     *
     * The caller decides per turn (see model-thinking.js: a spoken turn cannot
     * absorb an invisible reasoning phase, a text turn can and often needs it).
     * A server that has already rejected the field never receives it again.
     * An unspecified override keeps the conservative default of suppressing it.
     *
     * @param {unknown} override Per-call decision from the caller
     * @returns {boolean}
     */
    #shouldControlThinking(override) {
        const requested = typeof override === 'boolean' ? override : true;
        return requested && !thinkingControlUnsupportedServers.has(this.config.baseUrl);
    }

    /**
     * Posts one chat request, transparently retrying once without the
     * thinking control when the server rejects the request body outright.
     *
     * The retry is only safe because it happens BEFORE any response body is
     * handed to the caller, so no partial generation can be double-rendered.
     * A server that rejects the field for any other reason simply fails the
     * same way it would have without the control.
     *
     * @param {Array<{ role: string, content: string }>} messages Chat messages
     * @param {boolean} stream Whether to request a streamed response
     * @param {object} options Caller generation options
     * @param {AbortSignal} [signal] Abort signal
     * @param {unknown} [disableThinking] Per-call thinking decision
     * @returns {Promise<Response>} The accepted response
     */
    async #sendChat(messages, stream, options, signal, disableThinking) {
        const controlThinking = this.#shouldControlThinking(disableThinking);
        const first = await this.#request('/chat/completions', {
            method: 'POST', signal, body: JSON.stringify(this.#chatBody(messages, stream, options, controlThinking)),
        });
        if (first.ok || !controlThinking || !UNSUPPORTED_REQUEST_STATUSES.has(first.status)) {
            return assertOk(first);
        }
        thinkingControlUnsupportedServers.add(this.config.baseUrl);
        const second = await this.#request('/chat/completions', {
            method: 'POST', signal, body: JSON.stringify(this.#chatBody(messages, stream, options, false)),
        });
        return assertOk(second);
    }

    #chatBody(messages, stream, options, controlThinking) {
        if (!this.config.model) throw providerError('Model is not configured');
        if (!Array.isArray(messages)) throw providerError('Chat messages must be an array');
        const body = { model: this.config.model, messages, stream, ...options };
        // An explicit caller option always wins over the provider default.
        if (controlThinking && body.chat_template_kwargs === undefined) {
            body.chat_template_kwargs = { enable_thinking: false };
        }
        return body;
    }

    async #json(path, options) {
        const response = await assertOk(await this.#request(path, options));
        try { return await response.json(); } catch (cause) { throw providerError('Invalid JSON response from OpenAI-compatible server', { cause }); }
    }

    /**
     * Performs one HTTP request. Transport and shape failures throw; a
     * non-2xx status is returned to the caller so the chat path can decide
     * whether to retry before turning it into an error.
     * @param {string} path Endpoint path appended to the base URL
     * @param {object} options Fetch options
     * @returns {Promise<Response>} The raw response
     */
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
        return response;
    }
}

/**
 * Converts a non-2xx response into a controlled provider error, including the
 * server's own explanation when it sent one.
 * @param {Response} response Response to inspect
 * @returns {Promise<Response>} Resolves with the same response when it is successful
 */
async function assertOk(response) {
    if (response.ok) return response;
    let text = '';
    try { text = await response.text(); } catch { /* ignore unreadable error response */ }
    throw responseError(response.status, text);
}
