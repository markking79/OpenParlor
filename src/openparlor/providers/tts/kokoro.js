export class TtsProviderError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'TtsProviderError';
        this.code = code;
    }
}
function normalizeBaseUrl(url) {
    let normalized = url.replace(/\/+$/, '');
    if (!normalized.endsWith('/v1')) {
        normalized += '/v1';
    }
    return normalized;
}

export function createKokoroProvider({ baseUrl, apiKey }) {
    if (!baseUrl || typeof baseUrl !== 'string') {
        throw new TtsProviderError('INVALID_CONFIG', 'Kokoro provider requires a valid baseUrl');
    }
    if (apiKey != null && typeof apiKey !== 'string') {
        throw new TtsProviderError('INVALID_CONFIG', 'Kokoro provider apiKey must be a string when provided');
    }

    const normalizedBase = normalizeBaseUrl(baseUrl);
    const baseHeaders = { 'Content-Type': 'application/json' };
    if (apiKey) {
        baseHeaders.Authorization = `Bearer ${apiKey}`;
    }

    async function request(path, options = {}) {
        let response;
        try {
            response = await fetch(`${normalizedBase}${path}`, {
                ...options,
                headers: { ...baseHeaders, ...options.headers },
            });
        } catch {
            throw new TtsProviderError('UPSTREAM_UNREACHABLE', 'TTS upstream is unreachable');
        }

        if (!response.ok) {
            throw new TtsProviderError('UPSTREAM_ERROR', `TTS upstream returned status ${response.status}`);
        }

        return response;
    }

    return {
        async listVoices() {
            const res = await request('/audio/voices');
            const data = await res.json();
            return { ok: true, data };
        },

        async synthesize(text, options = {}) {
            if (typeof text !== 'string' || text.trim().length === 0) {
                throw new TtsProviderError('INVALID_INPUT', 'text must be a non-empty string');
            }
            if (options.voice != null && typeof options.voice !== 'string') {
                throw new TtsProviderError('INVALID_INPUT', 'options.voice must be a string');
            }
            if (options.model != null && typeof options.model !== 'string') {
                throw new TtsProviderError('INVALID_INPUT', 'options.model must be a string');
            }

            const body = { input: text };
            if (options.voice) body.voice = options.voice;
            if (options.model) body.model = options.model;

            const res = await request('/audio/speech', {
                method: 'POST',
                body: JSON.stringify(body),
            });

            const contentType = res.headers.get('content-type') || '';
            if (contentType.includes('application/json')) {
                const data = await res.json();
                return { ok: true, data };
            }
            const buffer = Buffer.from(await res.arrayBuffer());
            return { ok: true, data: buffer };
        },

        async health() {
            const res = await request('/models');
            const data = await res.json();
            return { ok: true, data };
        },
    };
}
