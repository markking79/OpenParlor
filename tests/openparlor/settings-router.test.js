import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOpenParlorSettingsRouter } from '../../src/openparlor/settings-router.js';

// Tests exercise the real settings router + persistence layer over HTTP with a
// mocked req.user (set via x-test-handle header).

let testRoot = '';

function createTestApp() {
    const app = express();
    app.use(express.json());

    app.use((req, res, next) => {
        const handle = req.headers['x-test-handle'];
        req.user = handle
            ? { profile: { handle }, directories: { root: testRoot } }
            : null;
        next();
    });

    app.use('/api/openparlor/settings', createOpenParlorSettingsRouter());
    return app;
}

function request(app, method, path, { body, handle } = {}) {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, () => {
            const port = server.address().port;
            const headers = { 'Content-Type': 'application/json' };
            if (handle) headers['x-test-handle'] = handle;

            const data = body !== undefined ? JSON.stringify(body) : null;
            const req = http.request({
                hostname: '127.0.0.1',
                port,
                path,
                method,
                headers,
            }, (res) => {
                let chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => {
                    server.close();
                    const raw = Buffer.concat(chunks).toString();
                    resolve({
                        status: res.statusCode,
                        body: raw ? JSON.parse(raw) : null,
                    });
                });
            });
            req.on('error', (e) => { server.close(); reject(e); });
            if (data) req.write(data);
            req.end();
        });
    });
}

describe('OpenParlor settings routes', () => {
    let app;

    beforeEach(() => {
        testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openparlor-test-'));
        app = createTestApp();
    });

    afterEach(() => {
        fs.rmSync(testRoot, { recursive: true, force: true });
    });

    it('should require authentication on GET', async () => {
        const res = await request(app, 'GET', '/api/openparlor/settings');
        assert.equal(res.status, 401);
        assert.deepEqual(res.body, { error: 'Authentication is required' });
    });

    it('should require authentication on PUT', async () => {
        const res = await request(app, 'PUT', '/api/openparlor/settings', { body: { autoSpeak: true } });
        assert.equal(res.status, 401);
        assert.deepEqual(res.body, { error: 'Authentication is required' });
    });

    it('should return default settings when none are saved', async () => {
        const res = await request(app, 'GET', '/api/openparlor/settings', { handle: 'alice' });
        assert.equal(res.status, 200);
        assert.equal(res.body.owner_id, 'alice');
        assert.ok(res.body.updated_at);
    });

    it('should save and reload settings for the owner', async () => {
        const put = await request(app, 'PUT', '/api/openparlor/settings', {
            body: { autoSpeak: true, volume: 0.8 },
            handle: 'alice',
        });
        assert.equal(put.status, 200);
        assert.equal(put.body.autoSpeak, true);
        assert.equal(put.body.volume, 0.8);
        assert.equal(put.body.owner_id, 'alice');

        const get = await request(app, 'GET', '/api/openparlor/settings', { handle: 'alice' });
        assert.equal(get.status, 200);
        assert.equal(get.body.autoSpeak, true);
        assert.equal(get.body.volume, 0.8);
    });

    it('should merge partial updates over existing settings', async () => {
        await request(app, 'PUT', '/api/openparlor/settings', {
            body: { autoSpeak: true, volume: 0.5 },
            handle: 'alice',
        });
        const put = await request(app, 'PUT', '/api/openparlor/settings', {
            body: { volume: 0.9 },
            handle: 'alice',
        });
        assert.equal(put.status, 200);
        assert.equal(put.body.autoSpeak, true);
        assert.equal(put.body.volume, 0.9);
    });

    it('should reject a non-object settings payload', async () => {
        const res = await request(app, 'PUT', '/api/openparlor/settings', {
            body: [1, 2, 3],
            handle: 'alice',
        });
        assert.equal(res.status, 400);
        assert.deepEqual(res.body, { error: 'Settings must be a JSON object' });
    });
});
