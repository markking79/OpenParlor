import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import { createOpenParlorCharacterRouter } from '../../src/openparlor/character-router.js';

// ─── Mock persistence ────────────────────────────────────────────────────────

function createMockPersistence() {
    const characters = new Map();
    return {
        characters,
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
        listCharacters(_directories, owner_id) {
            return [...characters.values()].filter(c => c.owner_id === owner_id);
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
    };
}

// ─── Test helpers ────────────────────────────────────────────────────────────

function makeUser(handle) {
    return {
        directories: { root: '/tmp/test-openparlor' },
        profile: { handle },
    };
}

function createTestApp(persistenceModule, user) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = user;
        next();
    });
    app.use('/api/openparlor/characters', createOpenParlorCharacterRouter({ persistence: persistenceModule }));
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
});
