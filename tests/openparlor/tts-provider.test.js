import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTtsProvider } from '../../src/openparlor/tts-provider.js';

const CONFIG = {
    provider: 'kokoro',
    baseUrl: 'http://kokoro.internal:9880',
    apiKey: 'secret-key-123',
};

let originalFetch;

beforeEach(() => {
    originalFetch = global.fetch;
});

afterEach(() => {
    global.fetch = originalFetch;
});

function mockFetch(impl) {
    global.fetch = impl;
}

describe('createTtsProvider factory', () => {
    test('throws on missing config', () => {
        assert.throws(() => createTtsProvider(null), { code: 'INVALID_CONFIG' });
    });

    test('throws on missing provider name', () => {
        assert.throws(() => createTtsProvider({}), { code: 'INVALID_CONFIG' });
    });

    test('throws on unknown provider', () => {
        assert.throws(() => createTtsProvider({ provider: 'unknown' }), { code: 'UNKNOWN_PROVIDER' });
    });

    test('returns kokoro provider with valid config', () => {
        const p = createTtsProvider(CONFIG);
        assert.equal(typeof p.listVoices, 'function');
        assert.equal(typeof p.synthesize, 'function');
        assert.equal(typeof p.health, 'function');
    });
});

describe('kokoro listVoices', () => {
    test('sends GET to /v1/audio/voices with auth header', async () => {
        let captured;
        mockFetch(async (url, opts) => {
            captured = { url, opts };
            return { ok: true, json: async () => [{ id: 'voice-1' }] };
        });

        const p = createTtsProvider(CONFIG);
        const result = await p.listVoices();

        assert.equal(captured.url, 'http://kokoro.internal:9880/v1/audio/voices');
        assert.equal(captured.opts.headers.Authorization, 'Bearer secret-key-123');
        assert.deepEqual(result, { ok: true, data: [{ id: 'voice-1' }] });
    });

    test('throws controlled error on upstream 500', async () => {
        mockFetch(async () => ({ ok: false, status: 500 }));
        const p = createTtsProvider(CONFIG);
        await assert.rejects(p.listVoices(), { code: 'UPSTREAM_ERROR' });
    });

    test('throws controlled error on network failure', async () => {
        mockFetch(async () => { throw new Error('ECONNREFUSED'); });
        const p = createTtsProvider(CONFIG);
        await assert.rejects(p.listVoices(), { code: 'UPSTREAM_UNREACHABLE' });
    });

    test('does not send Authorization header when apiKey is absent', async () => {
        let captured;
        mockFetch(async (url, opts) => {
            captured = { url, opts };
            return { ok: true, json: async () => [] };
        });

        const p = createTtsProvider({ provider: 'kokoro', baseUrl: 'http://kokoro.internal:9880' });
        await p.listVoices();

        assert.equal(captured.opts.headers.Authorization, undefined);
    });
});

describe('kokoro synthesize', () => {
    test('sends POST to /v1/audio/speech with correct body', async () => {
        let captured;
        mockFetch(async (url, opts) => {
            captured = { url, opts };
            return {
                ok: true,
                headers: { get: (h) => (h === 'content-type' ? 'audio/wav' : null) },
                arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
            };
        });

        const p = createTtsProvider(CONFIG);
        const result = await p.synthesize('hello world', { voice: 'af', model: 'kokoro-v1' });

        assert.equal(captured.url, 'http://kokoro.internal:9880/v1/audio/speech');
        assert.equal(captured.opts.method, 'POST');
        const body = JSON.parse(captured.opts.body);
        assert.deepEqual(body, { input: 'hello world', voice: 'af', model: 'kokoro-v1' });
        assert.ok(result.ok);
        assert.ok(Buffer.isBuffer(result.data));
    });

    test('rejects empty text', async () => {
        const p = createTtsProvider(CONFIG);
        await assert.rejects(p.synthesize(''), { code: 'INVALID_INPUT' });
    });

    test('rejects whitespace-only text', async () => {
        const p = createTtsProvider(CONFIG);
        await assert.rejects(p.synthesize('   '), { code: 'INVALID_INPUT' });
    });

    test('rejects non-string text', async () => {
        const p = createTtsProvider(CONFIG);
        await assert.rejects(p.synthesize(123), { code: 'INVALID_INPUT' });
    });

    test('rejects non-string voice option', async () => {
        const p = createTtsProvider(CONFIG);
        await assert.rejects(p.synthesize('hi', { voice: 42 }), { code: 'INVALID_INPUT' });
    });

    test('rejects non-string model option', async () => {
        const p = createTtsProvider(CONFIG);
        await assert.rejects(p.synthesize('hi', { model: true }), { code: 'INVALID_INPUT' });
    });

    test('does not leak baseUrl or apiKey in error message', async () => {
        mockFetch(async () => ({ ok: false, status: 503 }));
        const p = createTtsProvider(CONFIG);
        try {
            await p.synthesize('test');
            assert.fail('should have thrown');
        } catch (err) {
            assert.ok(!err.message.includes('kokoro.internal'), 'must not leak baseUrl');
            assert.ok(!err.message.includes('secret-key-123'), 'must not leak apiKey');
        }
    });
});

describe('kokoro base URL normalization', () => {
    test('normalizes trailing slash on baseUrl with /v1', async () => {
        let captured;
        mockFetch(async (url) => {
            captured = url;
            return { ok: true, json: async () => [] };
        });
        const p = createTtsProvider({ provider: 'kokoro', baseUrl: 'http://127.0.0.1:8880/v1/' });
        await p.listVoices();
        assert.equal(captured, 'http://127.0.0.1:8880/v1/audio/voices');
    });

    test('does not duplicate /v1 when already present in baseUrl', async () => {
        let captured;
        mockFetch(async (url) => {
            captured = url;
            return { ok: true, json: async () => [] };
        });
        const p = createTtsProvider({ provider: 'kokoro', baseUrl: 'http://127.0.0.1:8880/v1' });
        await p.listVoices();
        assert.equal(captured, 'http://127.0.0.1:8880/v1/audio/voices');
    });

    test('appends /v1 when absent from baseUrl', async () => {
        let captured;
        mockFetch(async (url) => {
            captured = url;
            return { ok: true, json: async () => [] };
        });
        const p = createTtsProvider({ provider: 'kokoro', baseUrl: 'http://127.0.0.1:8880' });
        await p.listVoices();
        assert.equal(captured, 'http://127.0.0.1:8880/v1/audio/voices');
    });
});

describe('kokoro health', () => {
    test('sends GET to /v1/models', async () => {
        let captured;
        mockFetch(async (url) => {
            captured = url;
            return { ok: true, json: async () => [{ id: 'kokoro-v1' }] };
        });

        const p = createTtsProvider(CONFIG);
        const result = await p.health();
        assert.equal(captured, 'http://kokoro.internal:9880/v1/models');
        assert.deepEqual(result, { ok: true, data: [{ id: 'kokoro-v1' }] });
    });

    test('throws controlled error on upstream failure', async () => {
        mockFetch(async () => ({ ok: false, status: 500 }));
        const p = createTtsProvider(CONFIG);
        await assert.rejects(p.health(), { code: 'UPSTREAM_ERROR' });
    });
});
