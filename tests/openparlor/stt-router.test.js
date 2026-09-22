import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { createAvatarUploadMiddleware } from '../../src/middleware/avatarUpload.js';
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

describe('global avatar upload middleware', () => {
    /**
     * Builds an app that mirrors the server-main.js middleware order: authentication,
     * the global avatar upload middleware, then the OpenParlor STT router.
     * @param {{ directories: object } | null} user
     * @param {object} [dependencies]
     * @param {string} uploadsPath
     * @returns {import('express').Express}
     */
    function appWithAvatarMiddleware(user, dependencies = {}, uploadsPath) {
        const app = express();
        app.use((req, _res, next) => { req.user = user; next(); });
        app.use(createAvatarUploadMiddleware(uploadsPath));
        app.use('/api/openparlor/stt', createOpenParlorSttRouter(dependencies));
        return app;
    }

    it('lets OpenParlor STT audio uploads bypass the global avatar parser', async () => {
        const uploadsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'openparlor-avatar-'));
        const user = { directories: { root: '/private/alice' } };
        const dependencies = {
            loadConfig: async () => ({ stt: sttConfig }),
            createProvider: () => ({ transcribe: async () => ({ text: 'bypassed', language: 'en' }) }),
        };
        try {
            await withServer(appWithAvatarMiddleware(user, dependencies, uploadsPath), async baseUrl => {
                const result = await fetch(`${baseUrl}/api/openparlor/stt/transcribe`, { method: 'POST', body: audioForm() });
                assert.equal(result.status, 200);
                assert.deepEqual(await result.json(), { text: 'bypassed', language: 'en' });
            });
        } finally {
            fs.rmSync(uploadsPath, { recursive: true, force: true });
        }
    });

    it('still parses and stores SillyTavern avatar uploads on non-STT routes', async () => {
        const uploadsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'openparlor-avatar-'));
        try {
            const app = express();
            app.use((req, _res, next) => { req.user = { directories: { root: '/private/alice' } }; next(); });
            app.use(createAvatarUploadMiddleware(uploadsPath));
            app.post('/api/avatar', (req, res) => { res.json({ filename: req.file ? req.file.filename : null, destination: req.file ? req.file.destination : null }); });
            await withServer(app, async baseUrl => {
                const form = new FormData();
                form.append('avatar', new Blob([Buffer.from('png-bytes')], { type: 'image/png' }), 'avatar.png');
                const result = await fetch(`${baseUrl}/api/avatar`, { method: 'POST', body: form });
                const body = await result.json();
                assert.equal(result.status, 200);
                assert.ok(body.filename);
                assert.equal(body.destination, uploadsPath);
            });
            assert.equal(fs.readdirSync(uploadsPath).length, 1);
        } finally {
            fs.rmSync(uploadsPath, { recursive: true, force: true });
        }
    });
});
