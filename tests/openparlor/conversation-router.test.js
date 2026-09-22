import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import express from 'express';
import { createOpenParlorConversationRouter } from '../../src/openparlor/conversation-router.js';
import * as persistence from '../../src/openparlor/persistence.js';

function makeTempDirs() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openparlor-conv-test-'));
    return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

async function withConversationServer(user, run, deps) {
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        request.user = user;
        next();
    });
    app.use('/api/openparlor/conversations', createOpenParlorConversationRouter(deps));
    const server = http.createServer(app);
    await new Promise(resolve => {
        server.once('listening', resolve);
        server.listen(0, '127.0.0.1');
    });
    const { port } = server.address();
    try {
        await run(`http://127.0.0.1:${port}`);
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
}

async function request(baseUrl, method, pathname, body) {
    const options = { method };
    if (body !== undefined) {
        options.headers = { 'Content-Type': 'application/json' };
        options.body = JSON.stringify(body);
    }
    const response = await fetch(`${baseUrl}/api/openparlor/conversations${pathname}`, options);
    const text = await response.text();
    let parsed;
    try {
        parsed = text ? JSON.parse(text) : null;
    } catch {
        parsed = null;
    }
    return { status: response.status, body: parsed, text };
}

test('requires authentication on all routes', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        for (const [method, pathname, body] of [
            ['POST', '/', { character_id: 'x', title: 't' }],
            ['GET', '/', undefined],
            ['GET', '/some-id', undefined],
            ['PATCH', '/some-id', { title: 't' }],
            ['DELETE', '/some-id', undefined],
        ]) {
            await withConversationServer(null, async baseUrl => {
                const result = await request(baseUrl, method, pathname, body);
                assert.equal(result.status, 401, `${method} ${pathname}`);
                assert.deepEqual(result.body, { error: 'Authentication is required' });
            });
        }
    } finally {
        tmp.cleanup();
    }
});

test('create: valid request returns 201 with conversation', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'alice', { name: 'TestChar' });
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withConversationServer(user, async baseUrl => {
            const result = await request(baseUrl, 'POST', '/', { character_id: char.id, title: 'My Chat' });
            assert.equal(result.status, 201);
            assert.equal(result.body.title, 'My Chat');
            assert.equal(result.body.owner_id, 'alice');
            assert.equal(result.body.character_id, char.id);
            assert.ok(result.body.id);
            assert.ok(Array.isArray(result.body.participants));
            assert.ok(result.body.participants.length >= 1);
            assert.equal(result.body.archived, false);
        });
    } finally {
        tmp.cleanup();
    }
});

test('create: rejects missing or invalid fields', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        persistence.createCharacter(dirs, 'alice', { name: 'C' });
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withConversationServer(user, async baseUrl => {
            const invalidBodies = [
                {},
                { character_id: '', title: 't' },
                { character_id: 'x', title: '' },
                { character_id: 42, title: 't' },
                { character_id: 'x', title: 42 },
                { character_id: '../evil', title: 't' },
            ];
            for (const body of invalidBodies) {
                const result = await request(baseUrl, 'POST', '/', body);
                assert.equal(result.status, 400, JSON.stringify(body));
            }
        });
    } finally {
        tmp.cleanup();
    }
});

test('create: rejects non-existent character with 404', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withConversationServer(user, async baseUrl => {
            const result = await request(baseUrl, 'POST', '/', { character_id: 'nonexistent-id', title: 't' });
            assert.equal(result.status, 404);
            assert.deepEqual(result.body, { error: 'Character not found' });
        });
    } finally {
        tmp.cleanup();
    }
});

test('create: rejects cross-user character with 403', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'bob', { name: 'BobChar' });
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withConversationServer(user, async baseUrl => {
            const result = await request(baseUrl, 'POST', '/', { character_id: char.id, title: 't' });
            assert.equal(result.status, 403);
            assert.deepEqual(result.body, { error: 'Forbidden' });
        });
    } finally {
        tmp.cleanup();
    }
});

test('list: returns only own non-archived conversations sorted by recency', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'alice', { name: 'C' });
        const bobChar = persistence.createCharacter(dirs, 'bob', { name: 'BC' });

        const conv1 = persistence.createConversation(dirs, 'alice', char.id, 'Old');
        await new Promise(r => setTimeout(r, 10));
        const conv2 = persistence.createConversation(dirs, 'alice', char.id, 'New');
        persistence.createConversation(dirs, 'bob', bobChar.id, 'BobConv');

        const user = { profile: { handle: 'alice' }, directories: dirs };
        await withConversationServer(user, async baseUrl => {
            const result = await request(baseUrl, 'GET', '/');
            assert.equal(result.status, 200);
            assert.equal(result.body.length, 2);
            assert.equal(result.body[0].id, conv2.id);
            assert.equal(result.body[1].id, conv1.id);
        });
    } finally {
        tmp.cleanup();
    }
});

test('load: returns conversation with messages', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'alice', { name: 'C' });
        const conv = persistence.createConversation(dirs, 'alice', char.id, 'Conv');
        const participant = conv.participants.find(p => p.role === 'character');
        persistence.appendMessage(dirs, conv.id, participant.id, 'hello', 'user');
        persistence.appendMessage(dirs, conv.id, participant.id, 'hi there', 'character');

        const user = { profile: { handle: 'alice' }, directories: dirs };
        await withConversationServer(user, async baseUrl => {
            const result = await request(baseUrl, 'GET', `/${conv.id}`);
            assert.equal(result.status, 200);
            assert.equal(result.body.id, conv.id);
            assert.equal(result.body.title, 'Conv');
            assert.equal(result.body.messages.length, 2);
            assert.equal(result.body.messages[0].content, 'hello');
            assert.equal(result.body.messages[0].role, 'user');
            assert.equal(result.body.messages[1].content, 'hi there');
            assert.equal(result.body.messages[1].role, 'character');
        });
    } finally {
        tmp.cleanup();
    }
});

test('load: returns 404 for non-existent conversation', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withConversationServer(user, async baseUrl => {
            const result = await request(baseUrl, 'GET', '/nonexistent');
            assert.equal(result.status, 404);
            assert.deepEqual(result.body, { error: 'Conversation not found' });
        });
    } finally {
        tmp.cleanup();
    }
});

test('load: returns 403 for cross-user conversation', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'bob', { name: 'C' });
        const conv = persistence.createConversation(dirs, 'bob', char.id, 'BobConv');
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withConversationServer(user, async baseUrl => {
            const result = await request(baseUrl, 'GET', `/${conv.id}`);
            assert.equal(result.status, 403);
            assert.deepEqual(result.body, { error: 'Forbidden' });
        });
    } finally {
        tmp.cleanup();
    }
});

test('rename: updates title', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'alice', { name: 'C' });
        const conv = persistence.createConversation(dirs, 'alice', char.id, 'Old Title');
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withConversationServer(user, async baseUrl => {
            const result = await request(baseUrl, 'PATCH', `/${conv.id}`, { title: 'New Title' });
            assert.equal(result.status, 200);
            assert.equal(result.body.title, 'New Title');
            assert.equal(result.body.id, conv.id);
        });
    } finally {
        tmp.cleanup();
    }
});

test('rename: rejects empty title with 400', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'alice', { name: 'C' });
        const conv = persistence.createConversation(dirs, 'alice', char.id, 'T');
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withConversationServer(user, async baseUrl => {
            const result = await request(baseUrl, 'PATCH', `/${conv.id}`, { title: '' });
            assert.equal(result.status, 400);
        });
    } finally {
        tmp.cleanup();
    }
});

test('archive: sets archived flag and excludes from list', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'alice', { name: 'C' });
        const conv = persistence.createConversation(dirs, 'alice', char.id, 'To Archive');
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withConversationServer(user, async baseUrl => {
            const result = await request(baseUrl, 'PATCH', `/${conv.id}`, { archived: true });
            assert.equal(result.status, 200);
            assert.equal(result.body.archived, true);

            const listResult = await request(baseUrl, 'GET', '/');
            assert.equal(listResult.body.length, 0);
        });
    } finally {
        tmp.cleanup();
    }
});

test('archive: rejects non-boolean with 400', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'alice', { name: 'C' });
        const conv = persistence.createConversation(dirs, 'alice', char.id, 'T');
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withConversationServer(user, async baseUrl => {
            const result = await request(baseUrl, 'PATCH', `/${conv.id}`, { archived: 'yes' });
            assert.equal(result.status, 400);
        });
    } finally {
        tmp.cleanup();
    }
});

test('delete: removes conversation and returns 204', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'alice', { name: 'C' });
        const conv = persistence.createConversation(dirs, 'alice', char.id, 'ToDelete');
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withConversationServer(user, async baseUrl => {
            const result = await request(baseUrl, 'DELETE', `/${conv.id}`);
            assert.equal(result.status, 204);

            const loadResult = await request(baseUrl, 'GET', `/${conv.id}`);
            assert.equal(loadResult.status, 404);
        });
    } finally {
        tmp.cleanup();
    }
});

test('delete: returns 403 for cross-user conversation', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'bob', { name: 'C' });
        const conv = persistence.createConversation(dirs, 'bob', char.id, 'BobConv');
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withConversationServer(user, async baseUrl => {
            const result = await request(baseUrl, 'DELETE', `/${conv.id}`);
            assert.equal(result.status, 403);
        });
    } finally {
        tmp.cleanup();
    }
});

test('restart/read round trip: conversation persists across router instances', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'alice', { name: 'C' });
        const user = { profile: { handle: 'alice' }, directories: dirs };

        let convId;
        // First "session": create
        await withConversationServer(user, async baseUrl => {
            const result = await request(baseUrl, 'POST', '/', { character_id: char.id, title: 'Persistent' });
            assert.equal(result.status, 201);
            convId = result.body.id;
        });

        // Second "session" (new router instance simulating restart): read
        await withConversationServer(user, async baseUrl => {
            const result = await request(baseUrl, 'GET', `/${convId}`);
            assert.equal(result.status, 200);
            assert.equal(result.body.title, 'Persistent');
            assert.equal(result.body.owner_id, 'alice');
            assert.equal(result.body.messages.length, 0);
        });
    } finally {
        tmp.cleanup();
    }
});

test('participants: PUT requires authentication', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        await withConversationServer(null, async baseUrl => {
            const result = await request(baseUrl, 'PUT', '/some-id/participants', { character_ids: ['x'] });
            assert.equal(result.status, 401);
            assert.deepEqual(result.body, { error: 'Authentication is required' });
        });
    } finally {
        tmp.cleanup();
    }
});

test('participants: PUT returns 404 for non-existent conversation', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withConversationServer(user, async baseUrl => {
            const result = await request(baseUrl, 'PUT', '/nonexistent/participants', { character_ids: ['x'] });
            assert.equal(result.status, 404);
            assert.deepEqual(result.body, { error: 'Conversation not found' });
        });
    } finally {
        tmp.cleanup();
    }
});

test('participants: PUT returns 403 for cross-user conversation', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'bob', { name: 'C' });
        const conv = persistence.createConversation(dirs, 'bob', char.id, 'BobConv');
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withConversationServer(user, async baseUrl => {
            const result = await request(baseUrl, 'PUT', `/${conv.id}/participants`, { character_ids: [char.id] });
            assert.equal(result.status, 403);
            assert.deepEqual(result.body, { error: 'Forbidden' });
        });
    } finally {
        tmp.cleanup();
    }
});

test('participants: PUT rejects empty character_ids array', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'alice', { name: 'C' });
        const conv = persistence.createConversation(dirs, 'alice', char.id, 'T');
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withConversationServer(user, async baseUrl => {
            const result = await request(baseUrl, 'PUT', `/${conv.id}/participants`, { character_ids: [] });
            assert.equal(result.status, 400);
        });
    } finally {
        tmp.cleanup();
    }
});

test('participants: PUT rejects non-array character_ids', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'alice', { name: 'C' });
        const conv = persistence.createConversation(dirs, 'alice', char.id, 'T');
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withConversationServer(user, async baseUrl => {
            const result = await request(baseUrl, 'PUT', `/${conv.id}/participants`, { character_ids: 'not-an-array' });
            assert.equal(result.status, 400);
        });
    } finally {
        tmp.cleanup();
    }
});

test('participants: PUT rejects duplicate character IDs', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'alice', { name: 'C' });
        const conv = persistence.createConversation(dirs, 'alice', char.id, 'T');
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withConversationServer(user, async baseUrl => {
            const result = await request(baseUrl, 'PUT', `/${conv.id}/participants`, { character_ids: [char.id, char.id] });
            assert.equal(result.status, 400);
            assert.ok(result.body.error.includes('Duplicate'));
        });
    } finally {
        tmp.cleanup();
    }
});

test('participants: PUT rejects non-existent character with 404', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'alice', { name: 'C' });
        const conv = persistence.createConversation(dirs, 'alice', char.id, 'T');
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withConversationServer(user, async baseUrl => {
            const result = await request(baseUrl, 'PUT', `/${conv.id}/participants`, { character_ids: ['nonexistent'] });
            assert.equal(result.status, 404);
            assert.deepEqual(result.body, { error: 'Character not found' });
        });
    } finally {
        tmp.cleanup();
    }
});

test('participants: PUT rejects cross-user character with 403', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const aliceChar = persistence.createCharacter(dirs, 'alice', { name: 'AC' });
        const bobChar = persistence.createCharacter(dirs, 'bob', { name: 'BC' });
        const conv = persistence.createConversation(dirs, 'alice', aliceChar.id, 'T');
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withConversationServer(user, async baseUrl => {
            const result = await request(baseUrl, 'PUT', `/${conv.id}/participants`, { character_ids: [bobChar.id] });
            assert.equal(result.status, 403);
            assert.deepEqual(result.body, { error: 'Forbidden' });
        });
    } finally {
        tmp.cleanup();
    }
});

test('participants: PUT valid update returns 200 with updated participants', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char1 = persistence.createCharacter(dirs, 'alice', { name: 'C1' });
        const char2 = persistence.createCharacter(dirs, 'alice', { name: 'C2' });
        const conv = persistence.createConversation(dirs, 'alice', char1.id, 'T');
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withConversationServer(user, async baseUrl => {
            const result = await request(baseUrl, 'PUT', `/${conv.id}/participants`, { character_ids: [char1.id, char2.id] });
            assert.equal(result.status, 200);
            assert.equal(result.body.participants.length, 2);
            const ids = result.body.participants.map(p => p.character_id);
            assert.ok(ids.includes(char1.id));
            assert.ok(ids.includes(char2.id));
            assert.ok(result.body.participants.every(p => p.id && p.conversation_id === conv.id && p.joined_at));

            const primaryChanged = await request(baseUrl, 'PUT', `/${conv.id}/participants`, { character_ids: [char2.id] });
            assert.equal(primaryChanged.status, 200);
            assert.equal(primaryChanged.body.character_id, char2.id);
            assert.deepEqual(primaryChanged.body.participants.map(p => p.character_id), [char2.id]);
        });
    } finally {
        tmp.cleanup();
    }
});

test('participants: PUT rejects path traversal in character ID', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'alice', { name: 'C' });
        const conv = persistence.createConversation(dirs, 'alice', char.id, 'T');
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withConversationServer(user, async baseUrl => {
            const result = await request(baseUrl, 'PUT', `/${conv.id}/participants`, { character_ids: ['../evil'] });
            assert.equal(result.status, 400);
        });
    } finally {
        tmp.cleanup();
    }
});

test('rejects path traversal in conversation ID', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withConversationServer(user, async baseUrl => {
            const result = await request(baseUrl, 'GET', '/..%2F..%2Fetc%2Fpasswd');
            assert.equal(result.status, 400);
        });
    } finally {
        tmp.cleanup();
    }
});

// ─── PUT /:id (legacy verb, shared with PATCH) ──────────────────────────────

test('PUT /:id renames a conversation (legacy verb, same validation as PATCH)', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'alice', { name: 'C' });
        const conv = persistence.createConversation(dirs, 'alice', char.id, 'Old');
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withConversationServer(user, async baseUrl => {
            const result = await request(baseUrl, 'PUT', `/${conv.id}`, { title: 'PUT Title' });
            assert.equal(result.status, 200);
            assert.equal(result.body.title, 'PUT Title');
            assert.equal(result.body.id, conv.id);
        });
    } finally {
        tmp.cleanup();
    }
});

test('PUT /:id rejects an empty body with 400', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'alice', { name: 'C' });
        const conv = persistence.createConversation(dirs, 'alice', char.id, 'T');
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withConversationServer(user, async baseUrl => {
            const result = await request(baseUrl, 'PUT', `/${conv.id}`, {});
            assert.equal(result.status, 400);
        });
    } finally {
        tmp.cleanup();
    }
});

// ─── Messages ────────────────────────────────────────────────────────────────

test('POST /:id/messages appends a message and GET /:id/messages returns it', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'alice', { name: 'C' });
        const conv = persistence.createConversation(dirs, 'alice', char.id, 'T');
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withConversationServer(user, async baseUrl => {
            const posted = await request(baseUrl, 'POST', `/${conv.id}/messages`, {
                participant_id: char.id,
                content: 'Hello there',
                role: 'user',
            });
            assert.equal(posted.status, 201);
            assert.equal(posted.body.content, 'Hello there');
            assert.equal(posted.body.role, 'user');
            assert.equal(posted.body.conversation_id, conv.id);

            const listed = await request(baseUrl, 'GET', `/${conv.id}/messages`);
            assert.equal(listed.status, 200);
            assert.equal(listed.body.length, 1);
            assert.equal(listed.body[0].content, 'Hello there');
        });
    } finally {
        tmp.cleanup();
    }
});

test('POST /:id/messages rejects missing content with 400', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'alice', { name: 'C' });
        const conv = persistence.createConversation(dirs, 'alice', char.id, 'T');
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withConversationServer(user, async baseUrl => {
            const result = await request(baseUrl, 'POST', `/${conv.id}/messages`, {
                participant_id: char.id,
                role: 'user',
            });
            assert.equal(result.status, 400);
        });
    } finally {
        tmp.cleanup();
    }
});

test('POST /:id/messages rejects an invalid role with 400', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'alice', { name: 'C' });
        const conv = persistence.createConversation(dirs, 'alice', char.id, 'T');
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withConversationServer(user, async baseUrl => {
            const result = await request(baseUrl, 'POST', `/${conv.id}/messages`, {
                participant_id: char.id,
                content: 'x',
                role: 'admin',
            });
            assert.equal(result.status, 400);
        });
    } finally {
        tmp.cleanup();
    }
});

test('POST /:id/messages returns 404 for a missing conversation', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withConversationServer(user, async baseUrl => {
            const result = await request(baseUrl, 'POST', '/nonexistent/messages', {
                participant_id: 'p',
                content: 'x',
                role: 'user',
            });
            assert.equal(result.status, 404);
        });
    } finally {
        tmp.cleanup();
    }
});

test('GET /:id/messages returns 403 for a non-owner', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'alice', { name: 'C' });
        const conv = persistence.createConversation(dirs, 'alice', char.id, 'T');
        const bob = { profile: { handle: 'bob' }, directories: dirs };

        await withConversationServer(bob, async baseUrl => {
            const result = await request(baseUrl, 'GET', `/${conv.id}/messages`);
            assert.equal(result.status, 403);
        });
    } finally {
        tmp.cleanup();
    }
});
