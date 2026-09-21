import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createOpenParlorTtsRouter, getValidVoiceIds } from '../../src/openparlor/tts-router.js';

function makeUser(handle) {
    return {
        directories: { root: '/tmp/test-openparlor-tts' },
        profile: { handle },
    };
}

function createTestApp(ttsProvider, user) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = user;
        next();
    });
    app.use('/api/openparlor/tts', createOpenParlorTtsRouter({ ttsProvider }));
    return app;
}

async function startServer(app) {
    return new Promise((resolve) => {
        const server = http.createServer(app);
        server.listen(0, '127.0.0.1', () => {
            const { port } = /** @type {import('net').AddressInfo} */ (server.address());
            resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
        });
    });
}

async function stopServer(server) {
    return new Promise((resolve) => server.close(resolve));
}

describe('OpenParlor TTS Router', () => {
    let server;
    let baseUrl;

    afterEach(async () => {
        if (server) await stopServer(server);
    });

    describe('authentication', () => {
        it('returns 401 when user is not set', async () => {
            const app = express();
            app.use(express.json());
            app.use('/api/openparlor/tts', createOpenParlorTtsRouter({}));
            ({ server, baseUrl } = await startServer(app));
            const res = await fetch(`${baseUrl}/api/openparlor/tts/voices`);
            assert.equal(res.status, 401);
        });
    });

    describe('voice list', () => {
        it('returns available voices when TTS is configured', async () => {
            const ttsProvider = {
                listVoices: () => ['af_heart', 'am_adam', 'bf_emma', 'unknown_voice'],
            };
            const app = createTestApp(ttsProvider, makeUser('alice'));
            ({ server, baseUrl } = await startServer(app));
            const res = await fetch(`${baseUrl}/api/openparlor/tts/voices`);
            assert.equal(res.status, 200);
            const body = await res.json();
            assert.equal(body.available, true);
            assert.deepEqual(body.voices, ['af_heart', 'am_adam', 'bf_emma', 'unknown_voice']);
        });

        it('returns unavailable when TTS provider is not configured', async () => {
            const app = createTestApp(undefined, makeUser('alice'));
            ({ server, baseUrl } = await startServer(app));
            const res = await fetch(`${baseUrl}/api/openparlor/tts/voices`);
            assert.equal(res.status, 200);
            const body = await res.json();
            assert.equal(body.available, false);
            assert.deepEqual(body.voices, []);
        });

        it('returns unavailable when TTS provider throws', async () => {
            const ttsProvider = {
                listVoices: () => { throw new Error('offline'); },
            };
            const app = createTestApp(ttsProvider, makeUser('alice'));
            ({ server, baseUrl } = await startServer(app));
            const res = await fetch(`${baseUrl}/api/openparlor/tts/voices`);
            assert.equal(res.status, 200);
            const body = await res.json();
            assert.equal(body.available, false);
            assert.deepEqual(body.voices, []);
        });

        it('returns unavailable when TTS provider returns non-array', async () => {
            const ttsProvider = {
                listVoices: () => 'not-an-array',
            };
            const app = createTestApp(ttsProvider, makeUser('alice'));
            ({ server, baseUrl } = await startServer(app));
            const res = await fetch(`${baseUrl}/api/openparlor/tts/voices`);
            assert.equal(res.status, 200);
            const body = await res.json();
            assert.equal(body.available, false);
            assert.deepEqual(body.voices, []);
        });

        it('filters out non-string voice IDs', async () => {
            const ttsProvider = {
                listVoices: () => ['af_heart', 'am_adam', 42, null, ''],
            };
            const app = createTestApp(ttsProvider, makeUser('alice'));
            ({ server, baseUrl } = await startServer(app));
            const res = await fetch(`${baseUrl}/api/openparlor/tts/voices`);
            const body = await res.json();
            assert.deepEqual(body.voices, ['af_heart', 'am_adam']);
        });

        it('returns unavailable when no valid string voices are returned', async () => {
            const ttsProvider = {
                listVoices: () => [42, null, ''],
            };
            const app = createTestApp(ttsProvider, makeUser('alice'));
            ({ server, baseUrl } = await startServer(app));
            const res = await fetch(`${baseUrl}/api/openparlor/tts/voices`);
            const body = await res.json();
            assert.equal(body.available, false);
            assert.deepEqual(body.voices, []);
        });

        it('handles async listVoices', async () => {
            const ttsProvider = {
                listVoices: async () => ['af_heart', 'bf_lily'],
            };
            const app = createTestApp(ttsProvider, makeUser('alice'));
            ({ server, baseUrl } = await startServer(app));
            const res = await fetch(`${baseUrl}/api/openparlor/tts/voices`);
            const body = await res.json();
            assert.equal(body.available, true);
            assert.deepEqual(body.voices, ['af_heart', 'bf_lily']);
        });

        it('normalizes adapter-shaped response with ok and data array of objects', async () => {
            const ttsProvider = {
                listVoices: () => ({
                    ok: true,
                    data: [
                        { id: 'af_heart', name: 'Heart', language: 'en' },
                        { id: 'am_adam', name: 'Adam', language: 'en' },
                        { id: 'bf_emma', name: 'Emma', language: 'en' },
                    ],
                }),
            };
            const app = createTestApp(ttsProvider, makeUser('alice'));
            ({ server, baseUrl } = await startServer(app));
            const res = await fetch(`${baseUrl}/api/openparlor/tts/voices`);
            assert.equal(res.status, 200);
            const body = await res.json();
            assert.equal(body.available, true);
            assert.deepEqual(body.voices, ['af_heart', 'am_adam', 'bf_emma']);
        });

        it('returns unavailable for adapter-shaped response with ok false', async () => {
            const ttsProvider = {
                listVoices: () => ({ ok: false, error: 'offline' }),
            };
            const app = createTestApp(ttsProvider, makeUser('alice'));
            ({ server, baseUrl } = await startServer(app));
            const res = await fetch(`${baseUrl}/api/openparlor/tts/voices`);
            const body = await res.json();
            assert.equal(body.available, false);
            assert.deepEqual(body.voices, []);
        });

        it('filters invalid entries from adapter-shaped data array', async () => {
            const ttsProvider = {
                listVoices: () => ({
                    ok: true,
                    data: [
                        { id: 'af_heart', name: 'Heart' },
                        { name: 'No ID' },
                        { id: '', name: 'Empty ID' },
                        null,
                        42,
                        { id: 'am_adam', name: 'Adam' },
                    ],
                }),
            };
            const app = createTestApp(ttsProvider, makeUser('alice'));
            ({ server, baseUrl } = await startServer(app));
            const res = await fetch(`${baseUrl}/api/openparlor/tts/voices`);
            const body = await res.json();
            assert.equal(body.available, true);
            assert.deepEqual(body.voices, ['af_heart', 'am_adam']);
        });

        it('normalizes production Kokoro adapter shape with data.voices nested array', async () => {
            const ttsProvider = {
                listVoices: () => ({
                    ok: true,
                    data: {
                        voices: [
                            { id: 'af_heart', name: 'Heart', language: 'en' },
                            { id: 'am_adam', name: 'Adam', language: 'en' },
                            { id: 'bf_emma', name: 'Emma', language: 'en' },
                        ],
                    },
                }),
            };
            const app = createTestApp(ttsProvider, makeUser('alice'));
            ({ server, baseUrl } = await startServer(app));
            const res = await fetch(`${baseUrl}/api/openparlor/tts/voices`);
            assert.equal(res.status, 200);
            const body = await res.json();
            assert.equal(body.available, true);
            assert.deepEqual(body.voices, ['af_heart', 'am_adam', 'bf_emma']);
        });

        it('returns unavailable for production adapter shape with empty voices array', async () => {
            const ttsProvider = {
                listVoices: () => ({
                    ok: true,
                    data: { voices: [] },
                }),
            };
            const app = createTestApp(ttsProvider, makeUser('alice'));
            ({ server, baseUrl } = await startServer(app));
            const res = await fetch(`${baseUrl}/api/openparlor/tts/voices`);
            const body = await res.json();
            assert.equal(body.available, false);
            assert.deepEqual(body.voices, []);
        });

        it('filters invalid entries from production adapter data.voices array', async () => {
            const ttsProvider = {
                listVoices: () => ({
                    ok: true,
                    data: {
                        voices: [
                            { id: 'af_heart', name: 'Heart' },
                            { name: 'No ID' },
                            { id: '', name: 'Empty' },
                            null,
                            42,
                            { id: 'am_adam', name: 'Adam' },
                        ],
                    },
                }),
            };
            const app = createTestApp(ttsProvider, makeUser('alice'));
            ({ server, baseUrl } = await startServer(app));
            const res = await fetch(`${baseUrl}/api/openparlor/tts/voices`);
            const body = await res.json();
            assert.equal(body.available, true);
            assert.deepEqual(body.voices, ['af_heart', 'am_adam']);
        });
    });

    describe('synthesize', () => {
        function makeSynthProvider(voices, audioBuffer) {
            return {
                listVoices: () => voices,
                synthesize: async (text, options) => {
                    if (!text || typeof text !== 'string') throw new Error('bad text');
                    return { ok: true, data: audioBuffer || Buffer.from('RIFF-fake-wav') };
                },
            };
        }

        it('returns 401 when user is not set', async () => {
            const app = express();
            app.use(express.json());
            app.use('/api/openparlor/tts', createOpenParlorTtsRouter({}));
            ({ server, baseUrl } = await startServer(app));
            const res = await fetch(`${baseUrl}/api/openparlor/tts/synthesize`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: 'hello', voice: 'af_heart' }),
            });
            assert.equal(res.status, 401);
        });

        it('returns 400 when text is missing', async () => {
            const provider = makeSynthProvider(['af_heart']);
            const app = createTestApp(provider, makeUser('alice'));
            ({ server, baseUrl } = await startServer(app));
            const res = await fetch(`${baseUrl}/api/openparlor/tts/synthesize`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ voice: 'af_heart' }),
            });
            assert.equal(res.status, 400);
            const body = await res.json();
            assert.equal(body.error, 'Text is required');
        });

        it('returns 400 when text is empty string', async () => {
            const provider = makeSynthProvider(['af_heart']);
            const app = createTestApp(provider, makeUser('alice'));
            ({ server, baseUrl } = await startServer(app));
            const res = await fetch(`${baseUrl}/api/openparlor/tts/synthesize`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: '', voice: 'af_heart' }),
            });
            assert.equal(res.status, 400);
        });

        it('returns 400 when text is whitespace only', async () => {
            const provider = makeSynthProvider(['af_heart']);
            const app = createTestApp(provider, makeUser('alice'));
            ({ server, baseUrl } = await startServer(app));
            const res = await fetch(`${baseUrl}/api/openparlor/tts/synthesize`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: '   ', voice: 'af_heart' }),
            });
            assert.equal(res.status, 400);
        });

        it('returns 400 when text exceeds 5000 chars', async () => {
            const provider = makeSynthProvider(['af_heart']);
            const app = createTestApp(provider, makeUser('alice'));
            ({ server, baseUrl } = await startServer(app));
            const res = await fetch(`${baseUrl}/api/openparlor/tts/synthesize`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: 'a'.repeat(5001), voice: 'af_heart' }),
            });
            assert.equal(res.status, 400);
            const body = await res.json();
            assert.equal(body.error, 'Text is too long');
        });

        it('returns 400 when voice is missing', async () => {
            const provider = makeSynthProvider(['af_heart']);
            const app = createTestApp(provider, makeUser('alice'));
            ({ server, baseUrl } = await startServer(app));
            const res = await fetch(`${baseUrl}/api/openparlor/tts/synthesize`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: 'hello' }),
            });
            assert.equal(res.status, 400);
            const body = await res.json();
            assert.equal(body.error, 'Voice is required');
        });

        it('returns 400 when voice is not in the valid set', async () => {
            const provider = makeSynthProvider(['af_heart', 'am_adam']);
            const app = createTestApp(provider, makeUser('alice'));
            ({ server, baseUrl } = await startServer(app));
            const res = await fetch(`${baseUrl}/api/openparlor/tts/synthesize`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: 'hello', voice: 'invalid_voice' }),
            });
            assert.equal(res.status, 400);
            const body = await res.json();
            assert.equal(body.error, 'Invalid voice');
        });

        it('returns 503 when TTS is not available (no voices)', async () => {
            const provider = makeSynthProvider([]);
            const app = createTestApp(provider, makeUser('alice'));
            ({ server, baseUrl } = await startServer(app));
            const res = await fetch(`${baseUrl}/api/openparlor/tts/synthesize`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: 'hello', voice: 'af_heart' }),
            });
            assert.equal(res.status, 503);
            const body = await res.json();
            assert.equal(body.error, 'TTS is not available');
        });

        it('returns 503 when TTS provider is not configured', async () => {
            const app = createTestApp(undefined, makeUser('alice'));
            ({ server, baseUrl } = await startServer(app));
            const res = await fetch(`${baseUrl}/api/openparlor/tts/synthesize`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: 'hello', voice: 'af_heart' }),
            });
            assert.equal(res.status, 503);
        });

        it('returns audio bytes with correct content type on success', async () => {
            const audioData = Buffer.from('RIFF-fake-wav-data');
            const provider = makeSynthProvider(['af_heart'], audioData);
            const app = createTestApp(provider, makeUser('alice'));
            ({ server, baseUrl } = await startServer(app));
            const res = await fetch(`${baseUrl}/api/openparlor/tts/synthesize`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: 'hello world', voice: 'af_heart' }),
            });
            assert.equal(res.status, 200);
            assert.equal(res.headers.get('content-type'), 'audio/wav');
            const buf = Buffer.from(await res.arrayBuffer());
            assert.deepEqual(buf, audioData);
        });

        it('returns 503 when provider synthesize throws', async () => {
            const provider = {
                listVoices: () => ['af_heart'],
                synthesize: async () => { throw new Error('upstream down'); },
            };
            const app = createTestApp(provider, makeUser('alice'));
            ({ server, baseUrl } = await startServer(app));
            const res = await fetch(`${baseUrl}/api/openparlor/tts/synthesize`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: 'hello', voice: 'af_heart' }),
            });
            assert.equal(res.status, 503);
            const body = await res.json();
            assert.equal(body.error, 'TTS synthesis failed');
        });

        it('returns 503 when provider synthesize returns non-buffer data', async () => {
            const provider = {
                listVoices: () => ['af_heart'],
                synthesize: async () => ({ ok: true, data: { error: 'upstream issue' } }),
            };
            const app = createTestApp(provider, makeUser('alice'));
            ({ server, baseUrl } = await startServer(app));
            const res = await fetch(`${baseUrl}/api/openparlor/tts/synthesize`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: 'hello', voice: 'af_heart' }),
            });
            assert.equal(res.status, 503);
            const body = await res.json();
            assert.equal(body.error, 'TTS synthesis failed');
        });

        it('does not leak provider URL or key in error responses', async () => {
            const provider = {
                listVoices: () => ['af_heart'],
                synthesize: async () => { throw new Error('connection to http://secret-key@internal:8080 failed'); },
            };
            const app = createTestApp(provider, makeUser('alice'));
            ({ server, baseUrl } = await startServer(app));
            const res = await fetch(`${baseUrl}/api/openparlor/tts/synthesize`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: 'hello', voice: 'af_heart' }),
            });
            const body = await res.json();
            assert.equal(body.error, 'TTS synthesis failed');
            assert.ok(!body.error.includes('secret-key'));
            assert.ok(!body.error.includes('internal'));
        });

        it('handles async listVoices and synthesize', async () => {
            const audioData = Buffer.from('async-audio');
            const provider = {
                listVoices: async () => ['af_heart'],
                synthesize: async (text, opts) => ({ ok: true, data: audioData }),
            };
            const app = createTestApp(provider, makeUser('alice'));
            ({ server, baseUrl } = await startServer(app));
            const res = await fetch(`${baseUrl}/api/openparlor/tts/synthesize`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: 'hello', voice: 'af_heart' }),
            });
            assert.equal(res.status, 200);
            const buf = Buffer.from(await res.arrayBuffer());
            assert.deepEqual(buf, audioData);
        });
    });

    describe('getValidVoiceIds', () => {
        it('returns a Set of valid voice IDs from the provider', async () => {
            const provider = { listVoices: () => ['af_heart', 'am_adam'] };
            const result = await getValidVoiceIds(provider, {});
            assert.ok(result instanceof Set);
            assert.ok(result.has('af_heart'));
            assert.ok(result.has('am_adam'));
            assert.equal(result.size, 2);
        });

        it('returns empty set when provider is not configured', async () => {
            const result = await getValidVoiceIds(undefined, { root: '/tmp/nonexistent' });
            assert.equal(result.size, 0);
        });

        it('returns empty set when provider throws', async () => {
            const provider = { listVoices: () => { throw new Error('offline'); } };
            const result = await getValidVoiceIds(provider, {});
            assert.equal(result.size, 0);
        });

        it('filters non-string and empty values', async () => {
            const provider = { listVoices: () => ['valid', 42, null, '', 'also-valid'] };
            const result = await getValidVoiceIds(provider, {});
            assert.deepEqual([...result].sort(), ['also-valid', 'valid']);
        });

        it('handles async provider', async () => {
            const provider = { listVoices: async () => ['af_heart'] };
            const result = await getValidVoiceIds(provider, {});
            assert.ok(result.has('af_heart'));
        });

        it('normalizes adapter-shaped response', async () => {
            const provider = {
                listVoices: () => ({
                    ok: true,
                    data: [
                        { id: 'af_heart', name: 'Heart' },
                        { id: 'am_adam', name: 'Adam' },
                    ],
                }),
            };
            const result = await getValidVoiceIds(provider, {});
            assert.ok(result instanceof Set);
            assert.ok(result.has('af_heart'));
            assert.ok(result.has('am_adam'));
            assert.equal(result.size, 2);
        });

        it('returns empty set for adapter-shaped response with ok false', async () => {
            const provider = { listVoices: () => ({ ok: false, error: 'down' }) };
            const result = await getValidVoiceIds(provider, {});
            assert.equal(result.size, 0);
        });

        it('normalizes production Kokoro adapter shape with data.voices', async () => {
            const provider = {
                listVoices: () => ({
                    ok: true,
                    data: {
                        voices: [
                            { id: 'af_heart', name: 'Heart' },
                            { id: 'am_adam', name: 'Adam' },
                        ],
                    },
                }),
            };
            const result = await getValidVoiceIds(provider, {});
            assert.ok(result instanceof Set);
            assert.ok(result.has('af_heart'));
            assert.ok(result.has('am_adam'));
            assert.equal(result.size, 2);
        });
    });
});
