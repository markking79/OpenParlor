import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createOpenParlorCharacterRouter } from '../../src/openparlor/character-router.js';
import { createOpenParlorConversationRouter } from '../../src/openparlor/conversation-router.js';
import * as realPersistence from '../../src/openparlor/persistence.js';

// ─── Mock persistence ────────────────────────────────────────────────────────

function createMockPersistence() {
    const characters = new Map();
    const mock = {
        characters,
        conversations: [],
        memories: [],
        createCharacter(_directories, owner_id, data) {
            const now = new Date().toISOString();
            const character = {
                id: crypto.randomUUID(),
                name: data.name ?? '',
                description: data.description ?? '',
                personality: data.personality ?? '',
                scenario: data.scenario ?? '',
                first_message: data.first_message ?? '',
                system_prompt: data.system_prompt ?? '',
                example_dialogue: data.example_dialogue ?? '',
                tags: Array.isArray(data.tags) ? data.tags.filter(t => typeof t === 'string') : [],
                ...(typeof data.avatar_url === 'string' ? { avatar_url: data.avatar_url } : {}),
                tts_provider: data.tts_provider ?? '',
                tts_voice: data.tts_voice ?? '',
                ...(typeof data.temperature === 'number' ? { temperature: data.temperature } : {}),
                ...(typeof data.max_tokens === 'number' ? { max_tokens: data.max_tokens } : {}),
                ...(typeof data.time_aware === 'boolean' ? { time_aware: data.time_aware } : {}),
                archived: false,
                owner_id,
                created_at: now,
                updated_at: now,
            };
            characters.set(character.id, character);
            return character;
        },
        getCharacter(_directories, id) {
            return characters.get(id) ?? null;
        },
        listCharacters(_directories, owner_id, { includeArchived = false } = {}) {
            return [...characters.values()]
                .filter(c => c.owner_id === owner_id)
                .filter(c => includeArchived || !c.archived);
        },
        updateCharacter(_directories, id, updates) {
            const existing = characters.get(id);
            if (!existing) return null;
            const updated = {
                ...existing,
                ...updates,
                id: existing.id,
                owner_id: existing.owner_id,
                created_at: existing.created_at,
                updated_at: new Date(Date.now() + 1).toISOString(),
            };
            characters.set(id, updated);
            return updated;
        },
        deleteCharacter(_directories, id) {
            return characters.delete(id);
        },
        archiveCharacter(_directories, id) {
            return mock.updateCharacter(_directories, id, { archived: true });
        },
        characterHasHistory(_directories, owner_id, character_id) {
            for (const conversation of mock.conversations) {
                if (conversation.owner_id !== owner_id) continue;
                if (conversation.character_id === character_id) return true;
                const participants = Array.isArray(conversation.participants) ? conversation.participants : [];
                if (participants.some(p => p && p.character_id === character_id)) return true;
            }
            for (const memory of mock.memories) {
                if (memory.owner_id !== owner_id) continue;
                if (memory.character_id === character_id) return true;
                if ((memory.known_by_character_ids ?? []).includes(character_id)) return true;
            }
            return false;
        },
        removeCharacterAvatarFile() {
            return false;
        },
        addConversationReference(conversation) {
            mock.conversations.push(conversation);
        },
        addMemoryReference(memory) {
            mock.memories.push(memory);
        },
    };
    return mock;
}

// ─── Test helpers ────────────────────────────────────────────────────────────

function makeUser(handle) {
    return {
        directories: { root: '/tmp/test-openparlor' },
        profile: { handle },
    };
}

const mockTtsProvider = {
    listVoices: () => ['af_heart', 'am_adam', 'bf_emma', 'bm_daniel'],
};

function createTestApp(persistenceModule, user, ttsProvider = mockTtsProvider) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = user;
        next();
    });
    app.use('/api/openparlor/characters', createOpenParlorCharacterRouter({ persistence: persistenceModule, ttsProvider }));
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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('OpenParlor Character Router', () => {
    let persistence;
    let server;
    let baseUrl;

    beforeEach(async () => {
        persistence = createMockPersistence();
        const app = createTestApp(persistence, makeUser('alice'));
        ({ server, baseUrl } = await startServer(app));
    });

    afterEach(async () => {
        if (server) await stopServer(server);
    });

    // ─── Lifecycle ───────────────────────────────────────────────────────────

    describe('lifecycle', () => {
        it('creates a character', async () => {
            const res = await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Test Char', description: 'A test' }),
            });
            assert.equal(res.status, 201);
            const body = await res.json();
            assert.equal(body.name, 'Test Char');
            assert.equal(body.description, 'A test');
            assert.equal(body.owner_id, 'alice');
            assert.ok(body.id);
            assert.ok(body.created_at);
            assert.ok(body.updated_at);
        });

        it('gets a character by id', async () => {
            const created = await (await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Fetch Me' }),
            })).json();

            const res = await fetch(`${baseUrl}/api/openparlor/characters/${created.id}`);
            assert.equal(res.status, 200);
            const body = await res.json();
            assert.equal(body.id, created.id);
            assert.equal(body.name, 'Fetch Me');
        });

        it('lists characters for the owner', async () => {
            await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'One' }),
            });
            await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Two' }),
            });

            const res = await fetch(`${baseUrl}/api/openparlor/characters`);
            assert.equal(res.status, 200);
            const body = await res.json();
            assert.equal(body.length, 2);
            assert.ok(body.every(c => c.owner_id === 'alice'));
        });

        it('updates a character', async () => {
            const created = await (await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Original' }),
            })).json();

            const res = await fetch(`${baseUrl}/api/openparlor/characters/${created.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Updated', tags: ['a', 'b'] }),
            });
            assert.equal(res.status, 200);
            const body = await res.json();
            assert.equal(body.name, 'Updated');
            assert.deepEqual(body.tags, ['a', 'b']);
            assert.equal(body.id, created.id);
        });

        it('updates a character via PUT (legacy verb, same validation)', async () => {
            const created = await (await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Original' }),
            })).json();

            const res = await fetch(`${baseUrl}/api/openparlor/characters/${created.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'PUT-updated', temperature: 0.7 }),
            });
            assert.equal(res.status, 200);
            const body = await res.json();
            assert.equal(body.name, 'PUT-updated');
            assert.equal(body.temperature, 0.7);
            assert.equal(body.id, created.id);
        });

        it('applies field validation to PUT (rejects an unsupported field)', async () => {
            const created = await (await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Guarded' }),
            })).json();

            // The legacy monolith PUT had no validation and would have stored
            // arbitrary fields. The canonical router must reject them.
            const res = await fetch(`${baseUrl}/api/openparlor/characters/${created.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'ok', owner_id: 'hacker', evil: true }),
            });
            assert.equal(res.status, 400);
        });

        it('applies length validation to PUT (rejects an oversized name)', async () => {
            const created = await (await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Guarded' }),
            })).json();

            const res = await fetch(`${baseUrl}/api/openparlor/characters/${created.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'x'.repeat(20_001) }),
            });
            assert.equal(res.status, 400);
        });

        it('rejects an empty PUT body', async () => {
            const created = await (await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Guarded' }),
            })).json();

            const res = await fetch(`${baseUrl}/api/openparlor/characters/${created.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            assert.equal(res.status, 400);
        });

        it('returns 404 for PUT on a non-existent character', async () => {
            const res = await fetch(`${baseUrl}/api/openparlor/characters/nonexistent`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'nope' }),
            });
            assert.equal(res.status, 404);
        });

        it('returns 403 for PUT on a non-owned character', async () => {
            const created = await (await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Alice Secret' }),
            })).json();

            const bobApp = createTestApp(persistence, makeUser('bob'));
            const { server: bobServer, baseUrl: bobUrl } = await startServer(bobApp);
            try {
                const res = await fetch(`${bobUrl}/api/openparlor/characters/${created.id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: 'hacked' }),
                });
                assert.equal(res.status, 403);
            } finally {
                await stopServer(bobServer);
            }
        });

        it('deletes a character', async () => {
            const created = await (await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Doomed' }),
            })).json();

            const delRes = await fetch(`${baseUrl}/api/openparlor/characters/${created.id}`, { method: 'DELETE' });
            assert.equal(delRes.status, 204);

            const getRes = await fetch(`${baseUrl}/api/openparlor/characters/${created.id}`);
            assert.equal(getRes.status, 404);
        });

        it('clones a character with a new id', async () => {
            const created = await (await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Original', description: 'desc' }),
            })).json();

            const res = await fetch(`${baseUrl}/api/openparlor/characters/${created.id}/clone`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            assert.equal(res.status, 201);
            const clone = await res.json();
            assert.notEqual(clone.id, created.id);
            assert.equal(clone.name, 'Copy of Original');
            assert.equal(clone.description, 'desc');
            assert.equal(clone.owner_id, 'alice');
        });

        it('clones a character with a custom name', async () => {
            const created = await (await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Original' }),
            })).json();

            const res = await fetch(`${baseUrl}/api/openparlor/characters/${created.id}/clone`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'My Clone' }),
            });
            assert.equal(res.status, 201);
            const clone = await res.json();
            assert.equal(clone.name, 'My Clone');
        });
    });

    // ─── Safe deletion policy ───────────────────────────────────────────────

    describe('safe deletion policy', () => {
        it('archives a referenced character instead of deleting it', async () => {
            const created = await (await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Referenced' }),
            })).json();

            persistence.addConversationReference({
                id: 'conv-1',
                owner_id: 'alice',
                character_id: created.id,
                participants: [],
                archived: false,
            });

            const delRes = await fetch(`${baseUrl}/api/openparlor/characters/${created.id}`, { method: 'DELETE' });
            assert.equal(delRes.status, 200);
            const body = await delRes.json();
            assert.equal(body.deleted, false);
            assert.equal(body.archived, true);
            assert.equal(body.character.id, created.id);
            assert.equal(body.character.archived, true);
            assert.equal(body.character.name, 'Referenced');

            // The record remains and stays resolvable by id…
            const getRes = await fetch(`${baseUrl}/api/openparlor/characters/${created.id}`);
            assert.equal(getRes.status, 200);
            assert.equal((await getRes.json()).archived, true);

            // …is hidden from the default list…
            const defaultList = await (await fetch(`${baseUrl}/api/openparlor/characters`)).json();
            assert.equal(defaultList.length, 0);

            // …but included when archived characters are requested.
            const fullList = await (await fetch(`${baseUrl}/api/openparlor/characters?include_archived=true`)).json();
            assert.equal(fullList.length, 1);
            assert.equal(fullList[0].id, created.id);
            assert.equal(fullList[0].archived, true);
        });

        it('does not purge an archived character that is still referenced', async () => {
            const created = await (await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Still Referenced' }),
            })).json();
            persistence.addConversationReference({
                id: 'conv-2',
                owner_id: 'alice',
                character_id: created.id,
                participants: [],
                archived: false,
            });

            const first = await fetch(`${baseUrl}/api/openparlor/characters/${created.id}`, { method: 'DELETE' });
            assert.equal(first.status, 200);
            await first.json();

            const second = await fetch(`${baseUrl}/api/openparlor/characters/${created.id}`, { method: 'DELETE' });
            assert.equal(second.status, 200);
            const secondBody = await second.json();
            assert.equal(secondBody.deleted, false);
            assert.equal(secondBody.archived, true);

            const getRes = await fetch(`${baseUrl}/api/openparlor/characters/${created.id}`);
            assert.equal(getRes.status, 200);
        });

        it('archives a character referenced only as a participant', async () => {
            const primary = await (await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Primary' }),
            })).json();
            const sidekick = await (await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Sidekick' }),
            })).json();
            persistence.addConversationReference({
                id: 'conv-3',
                owner_id: 'alice',
                character_id: primary.id,
                participants: [{ id: 'p1', character_id: sidekick.id, role: 'character' }],
                archived: false,
            });

            const delRes = await fetch(`${baseUrl}/api/openparlor/characters/${sidekick.id}`, { method: 'DELETE' });
            assert.equal(delRes.status, 200);
            const body = await delRes.json();
            assert.equal(body.archived, true);
            assert.equal(body.character.id, sidekick.id);
        });

        it('archives a character referenced only by a memory', async () => {
            const created = await (await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Memored' }),
            })).json();
            persistence.addMemoryReference({
                id: 'mem-1',
                owner_id: 'alice',
                character_id: created.id,
                known_by_character_ids: [created.id],
            });

            const delRes = await fetch(`${baseUrl}/api/openparlor/characters/${created.id}`, { method: 'DELETE' });
            assert.equal(delRes.status, 200);
            const body = await delRes.json();
            assert.equal(body.archived, true);
            assert.equal(body.deleted, false);
        });

        it('hard-deletes an archived character once its references are gone', async () => {
            const created = await (await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Outlived' }),
            })).json();
            persistence.addConversationReference({
                id: 'conv-4',
                owner_id: 'alice',
                character_id: created.id,
                participants: [],
                archived: false,
            });

            const first = await fetch(`${baseUrl}/api/openparlor/characters/${created.id}`, { method: 'DELETE' });
            assert.equal(first.status, 200);
            await first.json();

            // The conversation is deleted, leaving the character unreferenced.
            persistence.conversations.length = 0;
            const delRes = await fetch(`${baseUrl}/api/openparlor/characters/${created.id}`, { method: 'DELETE' });
            assert.equal(delRes.status, 204);

            const getRes = await fetch(`${baseUrl}/api/openparlor/characters/${created.id}`);
            assert.equal(getRes.status, 404);
        });

        it('hides archived characters from the default list only', async () => {
            const kept = await (await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Kept' }),
            })).json();
            const archived = await (await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Archived One' }),
            })).json();
            persistence.addConversationReference({
                id: 'conv-5',
                owner_id: 'alice',
                character_id: archived.id,
                participants: [],
                archived: false,
            });
            const delRes = await fetch(`${baseUrl}/api/openparlor/characters/${archived.id}`, { method: 'DELETE' });
            assert.equal(delRes.status, 200);
            await delRes.json();

            const defaultList = await (await fetch(`${baseUrl}/api/openparlor/characters`)).json();
            assert.deepEqual(defaultList.map(c => c.id), [kept.id]);

            const fullList = await (await fetch(`${baseUrl}/api/openparlor/characters?include_archived=true`)).json();
            assert.equal(fullList.length, 2);
            assert.ok(fullList.some(c => c.id === archived.id && c.archived === true));
        });
    });

    // ─── Validation ──────────────────────────────────────────────────────────

    describe('validation', () => {
        it('rejects create without name', async () => {
            const res = await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ description: 'no name' }),
            });
            assert.equal(res.status, 400);
            const body = await res.json();
            assert.match(body.error, /name/);
        });

        it('rejects create with empty name', async () => {
            const res = await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: '   ' }),
            });
            assert.equal(res.status, 400);
        });

        it('rejects unknown fields', async () => {
            const res = await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'X', secret_field: 'hack' }),
            });
            assert.equal(res.status, 400);
            const body = await res.json();
            assert.match(body.error, /Unsupported/);
        });

        it('rejects provider configuration fields', async () => {
            const res = await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'X', api_key: 'sk-123', model: 'gpt-4' }),
            });
            assert.equal(res.status, 400);
        });

        it('rejects path traversal in id', async () => {
            const res = await fetch(`${baseUrl}/api/openparlor/characters/..%2F..%2Fetc%2Fpasswd`);
            assert.equal(res.status, 400);
        });

        it('rejects id with forward slash', async () => {
            const res = await fetch(`${baseUrl}/api/openparlor/characters/foo/bar`);
            // Express will 404 since the route only matches a single segment
            assert.ok(res.status === 400 || res.status === 404);
        });

        it('rejects id with backslash', async () => {
            const res = await fetch(`${baseUrl}/api/openparlor/characters/foo%5Cbar`);
            assert.equal(res.status, 400);
        });

        it('rejects id with dot-dot', async () => {
            // Express normalizes ".." in the URL path before routing,
            // so the route never matches and returns 404.
            const res = await fetch(`${baseUrl}/api/openparlor/characters/..`);
            assert.equal(res.status, 404);
        });

        it('rejects invalid avatar_url with backslash', async () => {
            const res = await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'X', avatar_url: '/images\\evil.png' }),
            });
            assert.equal(res.status, 400);
        });

        it('rejects invalid avatar_url with dot-dot', async () => {
            const res = await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'X', avatar_url: '/../../etc/passwd' }),
            });
            assert.equal(res.status, 400);
        });

        it('rejects avatar_url that is not browser-relative', async () => {
            const res = await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'X', avatar_url: 'images/relative.png' }),
            });
            assert.equal(res.status, 400);
        });

        it('accepts valid avatar_url', async () => {
            const res = await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'X', avatar_url: '/avatars/test.png' }),
            });
            assert.equal(res.status, 201);
            const body = await res.json();
            assert.equal(body.avatar_url, '/avatars/test.png');
        });

        it('rejects tags that are not an array', async () => {
            const res = await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'X', tags: 'not-an-array' }),
            });
            assert.equal(res.status, 400);
        });

        it('rejects tags with empty strings', async () => {
            const res = await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'X', tags: ['valid', '  '] }),
            });
            assert.equal(res.status, 400);
        });

        it('rejects clone with unknown fields', async () => {
            const created = await (await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Original' }),
            })).json();

            const res = await fetch(`${baseUrl}/api/openparlor/characters/${created.id}/clone`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ api_key: 'sk-123', model: 'gpt-4' }),
            });
            assert.equal(res.status, 400);
            const body = await res.json();
            assert.match(body.error, /Unsupported/);
        });

        it('rejects clone with non-object body', async () => {
            const created = await (await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Original' }),
            })).json();

            const res = await fetch(`${baseUrl}/api/openparlor/characters/${created.id}/clone`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(['not', 'an', 'object']),
            });
            assert.equal(res.status, 400);
        });

        it('rejects clone with name and unknown field', async () => {
            const created = await (await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Original' }),
            })).json();

            const res = await fetch(`${baseUrl}/api/openparlor/characters/${created.id}/clone`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'My Clone', secret: 'hack' }),
            });
            assert.equal(res.status, 400);
            const body = await res.json();
            assert.match(body.error, /Unsupported/);
        });

        it('rejects update with empty body', async () => {
            const created = await (await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'X' }),
            })).json();

            const res = await fetch(`${baseUrl}/api/openparlor/characters/${created.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            assert.equal(res.status, 400);
        });

        it('returns 404 for non-existent character', async () => {
            const res = await fetch(`${baseUrl}/api/openparlor/characters/nonexistent-id`);
            assert.equal(res.status, 404);
        });

        it('rejects tts_provider field', async () => {
            const res = await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'X', tts_provider: 'kokoro' }),
            });
            assert.equal(res.status, 400);
            const body = await res.json();
            assert.match(body.error, /Unsupported/);
        });

        it('accepts valid tts_voice', async () => {
            const res = await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'X', tts_voice: 'af_heart' }),
            });
            assert.equal(res.status, 201);
            const body = await res.json();
            assert.equal(body.tts_voice, 'af_heart');
        });

        it('accepts empty tts_voice', async () => {
            const res = await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'X', tts_voice: '' }),
            });
            assert.equal(res.status, 201);
            const body = await res.json();
            assert.equal(body.tts_voice, '');
        });

        it('rejects invalid tts_voice', async () => {
            const res = await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'X', tts_voice: 'not_a_real_voice' }),
            });
            assert.equal(res.status, 400);
            const body = await res.json();
            assert.match(body.error, /tts_voice/);
        });

        it('rejects tts_voice that is not a string', async () => {
            const res = await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'X', tts_voice: 42 }),
            });
            assert.equal(res.status, 400);
        });

        it('accepts valid temperature', async () => {
            const res = await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'X', temperature: 0.7 }),
            });
            assert.equal(res.status, 201);
            const body = await res.json();
            assert.equal(body.temperature, 0.7);
        });

        it('accepts boundary temperature values 0 and 2', async () => {
            const res0 = await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'X', temperature: 0 }),
            });
            assert.equal(res0.status, 201);
            const res2 = await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Y', temperature: 2 }),
            });
            assert.equal(res2.status, 201);
        });

        it('rejects temperature below 0', async () => {
            const res = await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'X', temperature: -0.1 }),
            });
            assert.equal(res.status, 400);
            const body = await res.json();
            assert.match(body.error, /temperature/);
        });

        it('rejects temperature above 2', async () => {
            const res = await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'X', temperature: 2.5 }),
            });
            assert.equal(res.status, 400);
            const body = await res.json();
            assert.match(body.error, /temperature/);
        });

        it('rejects temperature that is not a number', async () => {
            const res = await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'X', temperature: 'hot' }),
            });
            assert.equal(res.status, 400);
        });

        it('accepts valid max_tokens', async () => {
            const res = await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'X', max_tokens: 2048 }),
            });
            assert.equal(res.status, 201);
            const body = await res.json();
            assert.equal(body.max_tokens, 2048);
        });

        it('accepts boundary max_tokens values 1 and 8192', async () => {
            const res1 = await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'X', max_tokens: 1 }),
            });
            assert.equal(res1.status, 201);
            const resMax = await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Y', max_tokens: 8192 }),
            });
            assert.equal(resMax.status, 201);
        });

        it('rejects max_tokens of 0', async () => {
            const res = await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'X', max_tokens: 0 }),
            });
            assert.equal(res.status, 400);
            const body = await res.json();
            assert.match(body.error, /max_tokens/);
        });

        it('rejects max_tokens above 8192', async () => {
            const res = await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'X', max_tokens: 99999 }),
            });
            assert.equal(res.status, 400);
            const body = await res.json();
            assert.match(body.error, /max_tokens/);
        });

        it('rejects max_tokens that is not an integer', async () => {
            const res = await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'X', max_tokens: 1.5 }),
            });
            assert.equal(res.status, 400);
        });

        it('rejects max_tokens that is not a number', async () => {
            const res = await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'X', max_tokens: 'long' }),
            });
            assert.equal(res.status, 400);
        });

        it('updates temperature and max_tokens on existing character', async () => {
            const created = await (await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'X' }),
            })).json();

            const res = await fetch(`${baseUrl}/api/openparlor/characters/${created.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ temperature: 1.2, max_tokens: 1024 }),
            });
            assert.equal(res.status, 200);
            const body = await res.json();
            assert.equal(body.temperature, 1.2);
            assert.equal(body.max_tokens, 1024);
        });

        it('rejects invalid temperature on update', async () => {
            const created = await (await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'X' }),
            })).json();

            const res = await fetch(`${baseUrl}/api/openparlor/characters/${created.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ temperature: 99 }),
            });
            assert.equal(res.status, 400);
        });

        it('rejects invalid max_tokens on update', async () => {
            const created = await (await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'X' }),
            })).json();

            const res = await fetch(`${baseUrl}/api/openparlor/characters/${created.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ max_tokens: -5 }),
            });
            assert.equal(res.status, 400);
        });

        it('accepts valid time_aware boolean', async () => {
            const res = await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'X', time_aware: true }),
            });
            assert.equal(res.status, 201);
            const body = await res.json();
            assert.equal(body.time_aware, true);
        });

        it('accepts time_aware: false', async () => {
            const res = await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'X', time_aware: false }),
            });
            assert.equal(res.status, 201);
            const body = await res.json();
            assert.equal(body.time_aware, false);
        });

        it('rejects time_aware that is not a boolean', async () => {
            const res = await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'X', time_aware: 'yes' }),
            });
            assert.equal(res.status, 400);
            const body = await res.json();
            assert.match(body.error, /time_aware/);
        });

        it('rejects time_aware that is a number', async () => {
            const res = await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'X', time_aware: 1 }),
            });
            assert.equal(res.status, 400);
        });

        it('updates time_aware on existing character', async () => {
            const created = await (await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'X' }),
            })).json();

            const res = await fetch(`${baseUrl}/api/openparlor/characters/${created.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ time_aware: true }),
            });
            assert.equal(res.status, 200);
            const body = await res.json();
            assert.equal(body.time_aware, true);
        });

        it('rejects invalid time_aware on update', async () => {
            const created = await (await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'X' }),
            })).json();

            const res = await fetch(`${baseUrl}/api/openparlor/characters/${created.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ time_aware: 'not-a-bool' }),
            });
            assert.equal(res.status, 400);
        });

        it('rejects tts_voice when TTS provider is not configured', async () => {
            const app = express();
            app.use(express.json());
            app.use((req, _res, next) => { req.user = makeUser('alice'); next(); });
            app.use('/api/openparlor/characters', createOpenParlorCharacterRouter({ persistence }));
            const { server: srv, baseUrl: url } = await startServer(app);
            try {
                const res = await fetch(`${url}/api/openparlor/characters`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: 'X', tts_voice: 'af_heart' }),
                });
                assert.equal(res.status, 400);
                const body = await res.json();
                assert.match(body.error, /tts_voice/);
            } finally {
                await stopServer(srv);
            }
        });

        it('updates tts_voice on existing character', async () => {
            const created = await (await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'X' }),
            })).json();

            const res = await fetch(`${baseUrl}/api/openparlor/characters/${created.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tts_voice: 'am_adam' }),
            });
            assert.equal(res.status, 200);
            const body = await res.json();
            assert.equal(body.tts_voice, 'am_adam');
        });

        it('rejects invalid tts_voice on update', async () => {
            const created = await (await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'X' }),
            })).json();

            const res = await fetch(`${baseUrl}/api/openparlor/characters/${created.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tts_voice: 'bogus' }),
            });
            assert.equal(res.status, 400);
        });
    });

    // ─── Cross-user isolation ────────────────────────────────────────────────

    describe('cross-user isolation', () => {
        it('cannot get another user\'s character', async () => {
            // Alice creates
            const created = await (await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Alice Secret' }),
            })).json();

            // Bob tries to access
            const bobApp = createTestApp(persistence, makeUser('bob'));
            const { server: bobServer, baseUrl: bobUrl } = await startServer(bobApp);
            try {
                const res = await fetch(`${bobUrl}/api/openparlor/characters/${created.id}`);
                assert.equal(res.status, 403);
            } finally {
                await stopServer(bobServer);
            }
        });

        it('cannot update another user\'s character', async () => {
            const created = await (await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Alice Char' }),
            })).json();

            const bobApp = createTestApp(persistence, makeUser('bob'));
            const { server: bobServer, baseUrl: bobUrl } = await startServer(bobApp);
            try {
                const res = await fetch(`${bobUrl}/api/openparlor/characters/${created.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: 'Hacked' }),
                });
                assert.equal(res.status, 403);
            } finally {
                await stopServer(bobServer);
            }
        });

        it('cannot delete another user\'s character', async () => {
            const created = await (await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Alice Char' }),
            })).json();

            const bobApp = createTestApp(persistence, makeUser('bob'));
            const { server: bobServer, baseUrl: bobUrl } = await startServer(bobApp);
            try {
                const res = await fetch(`${bobUrl}/api/openparlor/characters/${created.id}`, { method: 'DELETE' });
                assert.equal(res.status, 403);
            } finally {
                await stopServer(bobServer);
            }
        });

        it('cannot clone another user\'s character', async () => {
            const created = await (await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Alice Char' }),
            })).json();

            const bobApp = createTestApp(persistence, makeUser('bob'));
            const { server: bobServer, baseUrl: bobUrl } = await startServer(bobApp);
            try {
                const res = await fetch(`${bobUrl}/api/openparlor/characters/${created.id}/clone`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({}),
                });
                assert.equal(res.status, 403);
            } finally {
                await stopServer(bobServer);
            }
        });

        it('lists only own characters', async () => {
            // Alice creates
            await fetch(`${baseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Alice Only' }),
            });

            // Bob creates in same persistence
            const bobApp = createTestApp(persistence, makeUser('bob'));
            const { server: bobServer, baseUrl: bobUrl } = await startServer(bobApp);
            try {
                await fetch(`${bobUrl}/api/openparlor/characters`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: 'Bob Only' }),
                });

                const res = await fetch(`${bobUrl}/api/openparlor/characters`);
                const body = await res.json();
                assert.equal(body.length, 1);
                assert.equal(body[0].name, 'Bob Only');
            } finally {
                await stopServer(bobServer);
            }
        });
    });

    // ─── Auth ────────────────────────────────────────────────────────────────

    describe('authentication', () => {
        it('returns 401 when user is not set', async () => {
            const app = express();
            app.use(express.json());
            // No auth middleware — request.user will be undefined
            app.use('/api/openparlor/characters', createOpenParlorCharacterRouter({ persistence }));
            const { server: srv, baseUrl: url } = await startServer(app);
            try {
                const res = await fetch(`${url}/api/openparlor/characters`);
                assert.equal(res.status, 401);
            } finally {
                await stopServer(srv);
            }
        });
    });

    // ─── Acceptance (real persistence) ──────────────────────────────────────
    // Plan acceptance: create character → chat → memory → delete/archive →
    // the old conversation still loads and remains understandable.

    describe('acceptance with real persistence', () => {
        let tmpRoot;
        let realDirs;
        let app;
        let realServer;
        let realBaseUrl;

        beforeEach(async () => {
            tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openparlor-acceptance-'));
            realDirs = { root: tmpRoot };
            app = express();
            app.use(express.json());
            app.use((req, _res, next) => {
                req.user = { directories: realDirs, profile: { handle: 'alice' } };
                next();
            });
            app.use('/api/openparlor/characters', createOpenParlorCharacterRouter({ ttsProvider: mockTtsProvider }));
            app.use('/api/openparlor/conversations', createOpenParlorConversationRouter());
            ({ server: realServer, baseUrl: realBaseUrl } = await startServer(app));
        });

        afterEach(async () => {
            if (realServer) await stopServer(realServer);
            if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
        });

        it('archived character keeps its conversation and memory readable', async () => {
            // 1. Create character
            const character = await (await fetch(`${realBaseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Monica', avatar_url: '/img/alice/openparlor-avatar-111.png' }),
            })).json();

            // 2. Chat: create conversation and append user + character messages
            const conversation = await (await fetch(`${realBaseUrl}/api/openparlor/conversations`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ character_id: character.id, title: 'Coffee chat' }),
            })).json();
            const participant = conversation.participants.find(p => p.character_id === character.id);
            realPersistence.appendMessage(realDirs, conversation.id, 'user', 'Hi Monica!', 'user');
            realPersistence.appendMessage(realDirs, conversation.id, participant.id, 'Hey! How are you?', 'character');

            // 3. Memory attributed to the character
            realPersistence.createMemory(realDirs, 'alice', {
                character_id: character.id,
                conversation_id: conversation.id,
                content: 'User likes coffee',
                type: 'preference',
                known_by_character_ids: [character.id],
            });

            // 4. Delete → server archives (character is referenced)
            const delRes = await fetch(`${realBaseUrl}/api/openparlor/characters/${character.id}`, { method: 'DELETE' });
            assert.equal(delRes.status, 200);
            const delBody = await delRes.json();
            assert.equal(delBody.archived, true);
            assert.equal(delBody.deleted, false);

            // 5. Old conversation still loads with intact speaker references
            const convRes = await fetch(`${realBaseUrl}/api/openparlor/conversations/${conversation.id}`);
            assert.equal(convRes.status, 200);
            const convBody = await convRes.json();
            assert.equal(convBody.title, 'Coffee chat');
            assert.equal(convBody.messages.length, 2);
            assert.equal(convBody.messages[1].content, 'Hey! How are you?');
            // No dangling participant IDs: the archived record still resolves.
            const archived = realPersistence.getCharacter(realDirs, character.id);
            assert.ok(archived);
            assert.equal(archived.archived, true);
            assert.equal(archived.name, 'Monica');
            assert.equal(archived.avatar_url, '/img/alice/openparlor-avatar-111.png');
            for (const p of convBody.participants) {
                const resolved = realPersistence.getCharacter(realDirs, p.character_id);
                assert.ok(resolved, `participant reference ${p.character_id} must still resolve`);
            }

            // 6. Memory provenance remains readable
            const memories = realPersistence.listMemories(realDirs, 'alice', character.id);
            assert.equal(memories.length, 1);
            assert.equal(memories[0].content, 'User likes coffee');
            assert.equal(memories[0].character_id, character.id);

            // 7. Hidden from the default character list, present when asked
            const defaultList = await (await fetch(`${realBaseUrl}/api/openparlor/characters`)).json();
            assert.equal(defaultList.length, 0);
            const fullList = await (await fetch(`${realBaseUrl}/api/openparlor/characters?include_archived=true`)).json();
            assert.equal(fullList.length, 1);
            assert.equal(fullList[0].id, character.id);
            assert.equal(fullList[0].archived, true);

            // 8. Conversation list still shows the conversation (renderable)
            const convList = await (await fetch(`${realBaseUrl}/api/openparlor/conversations`)).json();
            assert.equal(convList.length, 1);
            assert.equal(convList[0].id, conversation.id);
        });

        it('hard-deletes an unreferenced character and leaves everything else intact', async () => {
            const keptChar = await (await fetch(`${realBaseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Kept' }),
            })).json();
            const keptConv = await (await fetch(`${realBaseUrl}/api/openparlor/conversations`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ character_id: keptChar.id, title: 'Kept chat' }),
            })).json();
            realPersistence.appendMessage(realDirs, keptConv.id, 'user', 'Hello', 'user');

            const doomed = await (await fetch(`${realBaseUrl}/api/openparlor/characters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Doomed' }),
            })).json();

            const delRes = await fetch(`${realBaseUrl}/api/openparlor/characters/${doomed.id}`, { method: 'DELETE' });
            assert.equal(delRes.status, 204);
            assert.equal(realPersistence.getCharacter(realDirs, doomed.id), null);

            // Unrelated conversation history is untouched
            const convRes = await fetch(`${realBaseUrl}/api/openparlor/conversations/${keptConv.id}`);
            assert.equal(convRes.status, 200);
            const convBody = await convRes.json();
            assert.equal(convBody.messages.length, 1);
            assert.equal(convBody.messages[0].content, 'Hello');
            assert.ok(realPersistence.getCharacter(realDirs, keptChar.id));
        });
    });
});
