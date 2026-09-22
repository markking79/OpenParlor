import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOpenParlorMemoryRouter } from '../../src/openparlor/memory-router.js';

// Tests exercise the real memory router + persistence layer over HTTP with a
// mocked req.user (set via x-test-handle header).

let testRoot = '';

function createTestApp() {
    const app = express();
    app.use(express.json());

    // Mock authentication middleware
    app.use((req, res, next) => {
        const handle = req.headers['x-test-handle'];
        req.user = handle
            ? { profile: { handle }, directories: { root: testRoot } }
            : null;
        next();
    });

    app.use('/api/openparlor/memories', createOpenParlorMemoryRouter());
    return app;
}

function request(app, method, path, { body, handle } = {}) {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, () => {
            const port = server.address().port;
            const headers = { 'Content-Type': 'application/json' };
            if (handle) headers['x-test-handle'] = handle;

            const data = body ? JSON.stringify(body) : null;
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

describe('OpenParlor memory routes', () => {
    let app;

    beforeEach(() => {
        testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openparlor-test-'));
        app = createTestApp();
    });

    afterEach(() => {
        fs.rmSync(testRoot, { recursive: true, force: true });
    });

    it('should require authentication on every route', async () => {
        const cases = [
            ['POST', '/api/openparlor/memories', { character_id: 'c', content: 'x' }],
            ['GET', '/api/openparlor/memories', undefined],
            ['GET', '/api/openparlor/memories/abc', undefined],
            ['PUT', '/api/openparlor/memories/abc', { content: 'x' }],
            ['DELETE', '/api/openparlor/memories/abc', undefined],
            ['PUT', '/api/openparlor/memories/abc/pin', { pinned: true }],
        ];
        for (const [method, url, body] of cases) {
            const res = await request(app, method, url, { body });
            assert.equal(res.status, 401, `${method} ${url}`);
            assert.deepEqual(res.body, { error: 'Authentication is required' });
        }
    });

    it('should create a memory for the authenticated user', async () => {
        const res = await request(app, 'POST', '/api/openparlor/memories', {
            body: { character_id: 'char-1', content: 'Test memory', type: 'fact', importance: 3 },
            handle: 'alice',
        });
        assert.equal(res.status, 201);
        assert.equal(res.body.owner_id, 'alice');
        assert.equal(res.body.content, 'Test memory');
    });

    it('should list only the requesting user\'s memories', async () => {
        await request(app, 'POST', '/api/openparlor/memories', {
            body: { character_id: 'char-1', content: 'Alice memory' },
            handle: 'alice',
        });
        await request(app, 'POST', '/api/openparlor/memories', {
            body: { character_id: 'char-1', content: 'Bob memory' },
            handle: 'bob',
        });

        const res = await request(app, 'GET', '/api/openparlor/memories', { handle: 'alice' });
        assert.equal(res.status, 200);
        assert.equal(res.body.length, 1);
        assert.equal(res.body[0].content, 'Alice memory');
    });

    it('should list memories filtered by character', async () => {
        await request(app, 'POST', '/api/openparlor/memories', {
            body: { character_id: 'char-a', content: 'For A', known_by_character_ids: ['char-a'] },
            handle: 'alice',
        });
        await request(app, 'POST', '/api/openparlor/memories', {
            body: { character_id: 'char-b', content: 'For B', known_by_character_ids: ['char-b'] },
            handle: 'alice',
        });

        const res = await request(app, 'GET', '/api/openparlor/memories?character_id=char-a', { handle: 'alice' });
        assert.equal(res.status, 200);
        assert.equal(res.body.length, 1);
        assert.equal(res.body[0].content, 'For A');
    });

    it('should get an existing memory', async () => {
        const created = await request(app, 'POST', '/api/openparlor/memories', {
            body: { character_id: 'char-1', content: 'Get me' },
            handle: 'alice',
        });
        const memId = created.body.id;

        const res = await request(app, 'GET', '/api/openparlor/memories/' + memId, { handle: 'alice' });
        assert.equal(res.status, 200);
        assert.equal(res.body.content, 'Get me');
    });

    it('should return 404 for a non-existent memory', async () => {
        const res = await request(app, 'GET', '/api/openparlor/memories/nonexistent', { handle: 'alice' });
        assert.equal(res.status, 404);
    });

    it('should reject a path-traversal memory ID', async () => {
        const res = await request(app, 'GET', '/api/openparlor/memories/..%2Fetc', { handle: 'alice' });
        assert.equal(res.status, 400);
    });

    it('should allow owner to update their memory', async () => {
        const created = await request(app, 'POST', '/api/openparlor/memories', {
            body: { character_id: 'char-1', content: 'Before' },
            handle: 'alice',
        });
        const memId = created.body.id;

        const res = await request(app, 'PUT', '/api/openparlor/memories/' + memId, {
            body: { content: 'After' },
            handle: 'alice',
        });
        assert.equal(res.status, 200);
        assert.equal(res.body.content, 'After');
    });

    it('should return 403 when non-owner tries to update', async () => {
        const created = await request(app, 'POST', '/api/openparlor/memories', {
            body: { character_id: 'char-1', content: 'Alice memory' },
            handle: 'alice',
        });
        const memId = created.body.id;

        const res = await request(app, 'PUT', '/api/openparlor/memories/' + memId, {
            body: { content: 'Hacked' },
            handle: 'bob',
        });
        assert.equal(res.status, 403);
    });

    it('should allow owner to delete their memory', async () => {
        const created = await request(app, 'POST', '/api/openparlor/memories', {
            body: { character_id: 'char-1', content: 'To delete' },
            handle: 'alice',
        });
        const memId = created.body.id;

        const res = await request(app, 'DELETE', '/api/openparlor/memories/' + memId, { handle: 'alice' });
        assert.equal(res.status, 204);

        const listRes = await request(app, 'GET', '/api/openparlor/memories', { handle: 'alice' });
        assert.equal(listRes.body.length, 0);
    });

    it('should return 403 when non-owner tries to delete', async () => {
        const created = await request(app, 'POST', '/api/openparlor/memories', {
            body: { character_id: 'char-1', content: 'Alice memory' },
            handle: 'alice',
        });
        const memId = created.body.id;

        const res = await request(app, 'DELETE', '/api/openparlor/memories/' + memId, { handle: 'bob' });
        assert.equal(res.status, 403);
    });

    it('should allow owner to pin their memory', async () => {
        const created = await request(app, 'POST', '/api/openparlor/memories', {
            body: { character_id: 'char-1', content: 'Pin me' },
            handle: 'alice',
        });
        const memId = created.body.id;

        const res = await request(app, 'PUT', '/api/openparlor/memories/' + memId + '/pin', {
            body: { pinned: true },
            handle: 'alice',
        });
        assert.equal(res.status, 200);
        assert.equal(res.body.pinned, true);
    });

    it('should toggle pin when no body provided', async () => {
        const created = await request(app, 'POST', '/api/openparlor/memories', {
            body: { character_id: 'char-1', content: 'Toggle me' },
            handle: 'alice',
        });
        const memId = created.body.id;

        // First toggle: false -> true
        const res1 = await request(app, 'PUT', '/api/openparlor/memories/' + memId + '/pin', {
            body: {},
            handle: 'alice',
        });
        assert.equal(res1.body.pinned, true);

        // Second toggle: true -> false
        const res2 = await request(app, 'PUT', '/api/openparlor/memories/' + memId + '/pin', {
            body: {},
            handle: 'alice',
        });
        assert.equal(res2.body.pinned, false);
    });

    it('should return 403 when non-owner tries to pin', async () => {
        const created = await request(app, 'POST', '/api/openparlor/memories', {
            body: { character_id: 'char-1', content: 'Alice memory' },
            handle: 'alice',
        });
        const memId = created.body.id;

        const res = await request(app, 'PUT', '/api/openparlor/memories/' + memId + '/pin', {
            body: { pinned: true },
            handle: 'bob',
        });
        assert.equal(res.status, 403);
    });

    it('should return 404 for pin on non-existent memory', async () => {
        const res = await request(app, 'PUT', '/api/openparlor/memories/nonexistent/pin', {
            body: { pinned: true },
            handle: 'alice',
        });
        assert.equal(res.status, 404);
    });
});
