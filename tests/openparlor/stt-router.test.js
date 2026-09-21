import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createOpenParlorSttRouter } from '../../src/openparlor/stt-router.js';

const sttConfig = { provider: 'faster-whisper', pythonExecutable: '/safe/python', runnerPath: '/safe/runner.py', modelPath: '/safe/model', modelCacheDir: '/safe/cache', maxAudioBytes: 1024, timeoutMs: 1000 };

function appFor(user, dependencies = {}) {
    const app = express();
    app.use((req, _res, next) => { req.user = user; next(); });
    app.use('/api/openparlor/stt', createOpenParlorSttRouter(dependencies));
    return app;
}

async function withServer(app, callback) {
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try { await callback(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise(resolve => server.close(resolve)); }
}

function audioForm(type = 'audio/webm', bytes = Buffer.from('recording')) {
    const form = new FormData();
    form.append('audio', new Blob([bytes], { type }), 'recording.webm');
    return form;
}

describe('OpenParlor STT router', () => {
    let calls;
    afterEach(() => { calls = undefined; });

    it('requires authentication before accepting an upload', async () => {
        await withServer(appFor(null), async baseUrl => {
            const result = await fetch(`${baseUrl}/api/openparlor/stt/transcribe`, { method: 'POST', body: audioForm() });
            assert.equal(result.status, 401);
            assert.deepEqual(await result.json(), { error: 'Authentication is required' });
        });
    });

    it('loads server-owned config and sends only recorded audio to the provider', async () => {
        const user = { directories: { root: '/private/alice' } };
        const dependencies = {
            loadConfig: async dirs => { assert.equal(dirs, user.directories); return { stt: sttConfig }; },
            createProvider: config => { assert.equal(config, sttConfig); return { transcribe: async audio => { calls = audio; return { text: ' hello ', language: 'EN' }; } }; },
        };
        await withServer(appFor(user, dependencies), async baseUrl => {
            const result = await fetch(`${baseUrl}/api/openparlor/stt/transcribe`, { method: 'POST', body: audioForm() });
            assert.equal(result.status, 200);
            assert.deepEqual(await result.json(), { text: 'hello', language: 'en' });
            assert.deepEqual(calls, Buffer.from('recording'));
        });
    });

    it('rejects missing, unsupported, oversized, and extra multipart input without calling a provider', async () => {
        let created = false;
        const dependencies = { loadConfig: async () => ({ stt: sttConfig }), createProvider: () => { created = true; return {}; } };
        const user = { directories: { root: '/private/alice' } };
        await withServer(appFor(user, dependencies), async baseUrl => {
            for (const body of [new FormData(), audioForm('text/plain'), audioForm('audio/webm', Buffer.alloc(10 * 1024 * 1024 + 1))]) {
                const result = await fetch(`${baseUrl}/api/openparlor/stt/transcribe`, { method: 'POST', body });
                assert.ok([400, 415].includes(result.status));
            }
            const extra = audioForm(); extra.append('language', 'en');
            const result = await fetch(`${baseUrl}/api/openparlor/stt/transcribe`, { method: 'POST', body: extra });
            assert.equal(result.status, 400);
        });
        assert.equal(created, false);
    });

    it('returns safe errors without provider configuration details', async () => {
        const user = { directories: { root: '/private/alice' } };
        await withServer(appFor(user, { loadConfig: async () => ({ stt: sttConfig }), createProvider: () => ({ transcribe: async () => { throw new Error('failed at /private/alice with secret'); } }) }), async baseUrl => {
            const result = await fetch(`${baseUrl}/api/openparlor/stt/transcribe`, { method: 'POST', body: audioForm() });
            const body = await result.json();
            assert.equal(result.status, 503);
            assert.equal(body.error, 'Transcription is unavailable');
            assert.ok(!body.error.includes('private'));
        });
    });
});
