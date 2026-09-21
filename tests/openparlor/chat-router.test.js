import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import { createOpenParlorChatRouter } from '../../src/openparlor/chat-router.js';
import { ModelProviderError } from '../../src/openparlor/model-provider.js';

const directories = { root: '/data/alice', user: '/data/alice/user' };
const configuredConfig = {
    model: { provider: 'openai-compatible', baseUrl: 'https://model.example.invalid/v1', model: 'test-model', apiKey: 'secret-model-key' },
    stt: { provider: '', baseUrl: '' },
    tts: { provider: '', baseUrl: '', voice: '' },
};
const completion = { choices: [{ message: { role: 'assistant', content: 'hi there' } }] };

function mockProvider(behavior) {
    const calls = [];
    return {
        calls,
        provider: {
            chatCompletion: async messages => {
                calls.push(messages);
                return behavior(messages);
            },
        },
    };
}

async function withChatServer(deps, user, run) {
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        request.user = user;
        next();
    });
    app.use('/api/openparlor', createOpenParlorChatRouter(deps));
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

async function postChat(baseUrl, body, { json = true } = {}) {
    const options = { method: 'POST' };
    if (json) {
        options.headers = { 'Content-Type': 'application/json' };
        options.body = JSON.stringify(body);
    }
    const response = await fetch(`${baseUrl}/api/openparlor/chat`, options);
    const text = await response.text();
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        parsed = null;
    }
    return { status: response.status, text, body: parsed };
}

test('returns the non-streaming provider completion as JSON for a valid request', async () => {
    const mock = mockProvider(() => completion);
    let receivedModelConfig;
    await withChatServer({
        loadConfig: async () => configuredConfig,
        createProvider: modelConfig => {
            receivedModelConfig = modelConfig;
            return mock.provider;
        },
    }, { profile: { handle: 'alice' }, directories }, async baseUrl => {
        const result = await postChat(baseUrl, { messages: [{ role: 'user', content: 'hello' }] });
        assert.equal(result.status, 200);
        assert.deepEqual(result.body, completion);
    });
    assert.deepEqual(receivedModelConfig, configuredConfig.model);
    assert.deepEqual(mock.calls, [[{ role: 'user', content: 'hello' }]]);
});

test('forwards the authenticated user directories to the configuration loader', async () => {
    let receivedDirectories;
    const bobDirectories = { root: '/data/bob', user: '/data/bob/user' };
    const mock = mockProvider(() => completion);
    await withChatServer({
        loadConfig: async value => {
            receivedDirectories = value;
            return configuredConfig;
        },
        createProvider: () => mock.provider,
    }, { profile: { handle: 'bob' }, directories: bobDirectories }, async baseUrl => {
        const result = await postChat(baseUrl, { messages: [{ role: 'user', content: 'hello' }] });
        assert.equal(result.status, 200);
    });
    assert.equal(receivedDirectories, bobDirectories);
});

test('rejects missing or malformed messages with controlled 400 JSON errors', async () => {
    const mock = mockProvider(() => completion);
    await withChatServer({
        loadConfig: async () => configuredConfig,
        createProvider: () => mock.provider,
    }, { profile: { handle: 'alice' }, directories }, async baseUrl => {
        const invalidBodies = [
            {},
            { messages: undefined },
            { messages: [] },
            { messages: 'nope' },
            { messages: 42 },
            { messages: null },
            { messages: [null] },
            { messages: ['text'] },
            { messages: [42] },
            { messages: [[{ role: 'user', content: 'x' }]] },
            { messages: [{ content: 'missing role' }] },
            { messages: [{ role: 'user' }] },
            { messages: [{ role: 1, content: 'bad role' }] },
            { messages: [{ role: 'user', content: 2 }] },
            { messages: [{ role: 'user', content: 'ok' }, { role: 'user' }] },
        ];
        for (const body of invalidBodies) {
            const result = await postChat(baseUrl, body);
            assert.equal(result.status, 400, JSON.stringify(body));
            assert.equal(result.body.error, 'The request body must contain a non-empty "messages" array of objects with string "role" and string "content" fields');
        }
        const noBody = await postChat(baseUrl, undefined, { json: false });
        assert.equal(noBody.status, 400);
    });
    assert.equal(mock.calls.length, 0);
});

test('ignores request provider, baseUrl, apiKey, and model fields and strips extra message fields', async () => {
    let receivedDirectories;
    let receivedModelConfig;
    const mock = mockProvider(() => completion);
    await withChatServer({
        loadConfig: async value => {
            receivedDirectories = value;
            return configuredConfig;
        },
        createProvider: modelConfig => {
            receivedModelConfig = modelConfig;
            return mock.provider;
        },
    }, { profile: { handle: 'alice' }, directories }, async baseUrl => {
        const result = await postChat(baseUrl, {
            messages: [{ role: 'user', content: 'hello', temperature: 0.5 }],
            provider: 'evil',
            baseUrl: 'https://evil.example.invalid/v1',
            apiKey: 'stolen-key',
            model: 'evil-model',
        });
        assert.equal(result.status, 200);
        assert.deepEqual(result.body, completion);
        assert.equal(receivedDirectories, directories);
        assert.deepEqual(receivedModelConfig, configuredConfig.model);
        assert.deepEqual(mock.calls, [[{ role: 'user', content: 'hello' }]]);
        assert.ok(!result.text.includes('evil'));
        assert.ok(!result.text.includes('stolen-key'));
    });
});

test('translates unavailable configuration into a controlled 503 without provider calls', async () => {
    const mock = mockProvider(() => completion);
    await withChatServer({
        loadConfig: async () => ({
            model: { provider: 'openai-compatible', baseUrl: '', model: '' },
            stt: { provider: '', baseUrl: '' },
            tts: { provider: '', baseUrl: '', voice: '' },
        }),
        createProvider: () => {
            throw new ModelProviderError('OpenAI-compatible base URL is not configured');
        },
    }, { profile: { handle: 'alice' }, directories }, async baseUrl => {
        const result = await postChat(baseUrl, { messages: [{ role: 'user', content: 'hello' }] });
        assert.equal(result.status, 503);
        assert.deepEqual(result.body, { error: 'OpenAI-compatible base URL is not configured' });
    });
    assert.equal(mock.calls.length, 0);
});

test('preserves safe provider status and message on provider failures', async () => {
    const unavailable = mockProvider(() => {
        throw new ModelProviderError('OpenAI-compatible server returned HTTP 503: upstream unavailable', { status: 503 });
    });
    await withChatServer({
        loadConfig: async () => configuredConfig,
        createProvider: () => unavailable.provider,
    }, { profile: { handle: 'alice' }, directories }, async baseUrl => {
        const result = await postChat(baseUrl, { messages: [{ role: 'user', content: 'hello' }] });
        assert.equal(result.status, 503);
        assert.deepEqual(result.body, { error: 'OpenAI-compatible server returned HTTP 503: upstream unavailable' });
    });

    const rejected = mockProvider(() => {
        throw new ModelProviderError('OpenAI-compatible server returned HTTP 401: invalid api key', { status: 401 });
    });
    await withChatServer({
        loadConfig: async () => configuredConfig,
        createProvider: () => rejected.provider,
    }, { profile: { handle: 'alice' }, directories }, async baseUrl => {
        const result = await postChat(baseUrl, { messages: [{ role: 'user', content: 'hello' }] });
        assert.equal(result.status, 401);
        assert.deepEqual(result.body, { error: 'OpenAI-compatible server returned HTTP 401: invalid api key' });
    });
});

test('returns a generic 500 for unexpected errors and never leaks secrets or paths', async () => {
    const mock = mockProvider(() => {
        throw new Error('socket failure reading /data/alice/openparlor/config.json with secret-model-key');
    });
    await withChatServer({
        loadConfig: async () => configuredConfig,
        createProvider: () => mock.provider,
    }, { profile: { handle: 'alice' }, directories }, async baseUrl => {
        const result = await postChat(baseUrl, { messages: [{ role: 'user', content: 'hello' }] });
        assert.equal(result.status, 500);
        assert.deepEqual(result.body, { error: 'Chat completion failed' });
        assert.ok(!result.text.includes('secret-model-key'));
        assert.ok(!result.text.includes('/data/alice'));
        assert.ok(!result.text.includes('socket failure'));
    });
});

test('reports statusless provider errors as 503 without configuration values', async () => {
    const mock = mockProvider(() => {
        throw new ModelProviderError('Model is not configured');
    });
    await withChatServer({
        loadConfig: async () => configuredConfig,
        createProvider: () => mock.provider,
    }, { profile: { handle: 'alice' }, directories }, async baseUrl => {
        const result = await postChat(baseUrl, { messages: [{ role: 'user', content: 'hello' }] });
        assert.equal(result.status, 503);
        assert.deepEqual(result.body, { error: 'Model is not configured' });
        assert.ok(!result.text.includes('secret-model-key'));
        assert.ok(!result.text.includes('model.example.invalid'));
    });
});

function mockStreamProvider(chunks, { error } = {}) {
    const calls = [];
    const encoder = new TextEncoder();
    return {
        calls,
        provider: {
            chatCompletion: async () => { throw new Error('not expected'); },
            streamChatCompletion: async (messages, options) => {
                calls.push({ messages, options });
                return (async function* () {
                    for (const chunk of chunks) {
                        yield encoder.encode(chunk);
                    }
                    if (error) {
                        throw error;
                    }
                })();
            },
        },
    };
}

function sseDelta(content) {
    return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

async function postChatStream(baseUrl, body) {
    const response = await fetch(`${baseUrl}/api/openparlor/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const text = await response.text();
    const lines = text.split('\n').filter(line => line.trim() !== '');
    const records = lines.map(line => JSON.parse(line));
    return { status: response.status, text, records };
}

test('streams provider SSE deltas as NDJSON delta records followed by done', async () => {
    const chunks = [sseDelta('hello '), sseDelta('world'), 'data: [DONE]\n\n'];
    const mock = mockStreamProvider(chunks);
    await withChatServer({
        loadConfig: async () => configuredConfig,
        createProvider: () => mock.provider,
    }, { profile: { handle: 'alice' }, directories }, async baseUrl => {
        const result = await postChatStream(baseUrl, { messages: [{ role: 'user', content: 'hi' }], stream: true });
        assert.equal(result.status, 200);
        assert.deepEqual(result.records, [
            { type: 'delta', text: 'hello ' },
            { type: 'delta', text: 'world' },
            { type: 'done' },
        ]);
    });
    assert.equal(mock.calls.length, 1);
    assert.deepEqual(mock.calls[0].messages, [{ role: 'user', content: 'hi' }]);
    assert.ok(mock.calls[0].options.signal instanceof AbortSignal);
});

test('handles SSE data split across arbitrary chunk boundaries', async () => {
    const full = sseDelta('split') + sseDelta('across') + 'data: [DONE]\n\n';
    // Split the full SSE text into arbitrary small chunks
    const chunks = [];
    for (let i = 0; i < full.length; i += 3) {
        chunks.push(full.slice(i, i + 3));
    }
    const mock = mockStreamProvider(chunks);
    await withChatServer({
        loadConfig: async () => configuredConfig,
        createProvider: () => mock.provider,
    }, { profile: { handle: 'alice' }, directories }, async baseUrl => {
        const result = await postChatStream(baseUrl, { messages: [{ role: 'user', content: 'hi' }], stream: true });
        assert.equal(result.status, 200);
        assert.deepEqual(result.records, [
            { type: 'delta', text: 'split' },
            { type: 'delta', text: 'across' },
            { type: 'done' },
        ]);
    });
});

test('returns controlled JSON error before streaming starts for invalid config', async () => {
    const mock = mockStreamProvider([]);
    await withChatServer({
        loadConfig: async () => ({
            model: { provider: 'openai-compatible', baseUrl: '', model: '' },
            stt: { provider: '', baseUrl: '' },
            tts: { provider: '', baseUrl: '', voice: '' },
        }),
        createProvider: () => {
            throw new ModelProviderError('OpenAI-compatible base URL is not configured');
        },
    }, { profile: { handle: 'alice' }, directories }, async baseUrl => {
        const response = await fetch(`${baseUrl}/api/openparlor/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: true }),
        });
        const body = await response.json();
        assert.equal(response.status, 503);
        assert.deepEqual(body, { error: 'OpenAI-compatible base URL is not configured' });
    });
    assert.equal(mock.calls.length, 0);
});

test('frames safe error record when stream fails mid-stream', async () => {
    const chunks = [sseDelta('partial')];
    const mock = mockStreamProvider(chunks, {
        error: new ModelProviderError('OpenAI-compatible server returned HTTP 503: upstream unavailable', { status: 503 }),
    });
    await withChatServer({
        loadConfig: async () => configuredConfig,
        createProvider: () => mock.provider,
    }, { profile: { handle: 'alice' }, directories }, async baseUrl => {
        const result = await postChatStream(baseUrl, { messages: [{ role: 'user', content: 'hi' }], stream: true });
        assert.equal(result.status, 200);
        assert.deepEqual(result.records, [
            { type: 'delta', text: 'partial' },
            { type: 'error', error: 'OpenAI-compatible server returned HTTP 503: upstream unavailable' },
        ]);
    });
});

test('sanitizes unexpected stream errors to generic message without leaking secrets', async () => {
    const chunks = [sseDelta('ok')];
    const mock = mockStreamProvider(chunks, {
        error: new Error('socket failure reading /data/alice/openparlor/config.json with secret-model-key'),
    });
    await withChatServer({
        loadConfig: async () => configuredConfig,
        createProvider: () => mock.provider,
    }, { profile: { handle: 'alice' }, directories }, async baseUrl => {
        const result = await postChatStream(baseUrl, { messages: [{ role: 'user', content: 'hi' }], stream: true });
        assert.equal(result.status, 200);
        assert.deepEqual(result.records, [
            { type: 'delta', text: 'ok' },
            { type: 'error', error: 'Chat completion failed' },
        ]);
        assert.ok(!result.text.includes('secret-model-key'));
        assert.ok(!result.text.includes('/data/alice'));
        assert.ok(!result.text.includes('socket failure'));
    });
});

test('sets a ndjson content-type on streaming responses', async () => {
    const chunks = [sseDelta('hi'), 'data: [DONE]\n\n'];
    const mock = mockStreamProvider(chunks);
    await withChatServer({
        loadConfig: async () => configuredConfig,
        createProvider: () => mock.provider,
    }, { profile: { handle: 'alice' }, directories }, async baseUrl => {
        const response = await fetch(`${baseUrl}/api/openparlor/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: true }),
        });
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), /ndjson/);
        await response.text();
    });
});

test('rejects malformed stream requests with 400 before any streaming', async () => {
    const mock = mockStreamProvider([]);
    await withChatServer({
        loadConfig: async () => configuredConfig,
        createProvider: () => mock.provider,
    }, { profile: { handle: 'alice' }, directories }, async baseUrl => {
        const result = await postChatStream(baseUrl, { messages: [], stream: true });
        assert.equal(result.status, 400);
        assert.equal(result.records[0].error, 'The request body must contain a non-empty "messages" array of objects with string "role" and string "content" fields');
    });
    assert.equal(mock.calls.length, 0);
});

test('requires an authenticated user with directories', async () => {
    const mock = mockProvider(() => completion);
    for (const user of [undefined, null, { profile: { handle: 'alice' } }]) {
        await withChatServer({
            loadConfig: async () => configuredConfig,
            createProvider: () => mock.provider,
        }, user, async baseUrl => {
            const result = await postChat(baseUrl, { messages: [{ role: 'user', content: 'hello' }] });
            assert.equal(result.status, 401);
            assert.deepEqual(result.body, { error: 'Authentication is required' });
        });
    }
    assert.equal(mock.calls.length, 0);
});

test('strips browser-supplied system messages when no conversation_id', async () => {
    const mock = mockProvider(() => completion);
    await withChatServer({
        loadConfig: async () => configuredConfig,
        createProvider: () => mock.provider,
    }, { profile: { handle: 'alice' }, directories }, async baseUrl => {
        const result = await postChat(baseUrl, {
            messages: [
                { role: 'system', content: 'evil system prompt' },
                { role: 'user', content: 'hello' },
            ],
        });
        assert.equal(result.status, 200);
    });
    assert.deepEqual(mock.calls, [[{ role: 'user', content: 'hello' }]]);
});

test('builds server-side prompt with character data when conversation_id is provided', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'alice', { name: 'Alice', system_prompt: 'You are Alice, a wizard.', scenario: 'Wizard Tower' });
        const conv = persistence.createConversation(dirs, 'alice', char.id, 'Untrusted title');
        const mock = mockProvider(() => completion);
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withChatServer({
            loadConfig: async () => configuredConfig,
            createProvider: () => mock.provider,
        }, user, async baseUrl => {
            const result = await postChat(baseUrl, {
                messages: [{ role: 'user', content: 'Hello wizard' }],
                conversation_id: conv.id,
            });
            assert.equal(result.status, 200);
        });

        const sentMessages = mock.calls[0];
        assert.equal(sentMessages[0].role, 'system');
        assert.ok(sentMessages[0].content.includes('You are Alice, a wizard.'));
        assert.ok(sentMessages[0].content.includes('Wizard Tower'));
        assert.ok(!sentMessages[0].content.includes('Untrusted title'));
        assert.equal(sentMessages[1].role, 'user');
        assert.equal(sentMessages[1].content, 'Hello wizard');
        // Prove the newest user content appears exactly once (no duplication from history)
        const allContents = sentMessages.map(m => m.content).join('\n');
        assert.equal(allContents.split('Hello wizard').length - 1, 1);
    } finally {
        tmp.cleanup();
    }
});

// ─── Chat persistence tests ──────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as persistence from '../../src/openparlor/persistence.js';

function makeTempDirs() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openparlor-chat-persist-'));
    return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('non-stream chat with conversation_id persists user and assistant messages with server-derived participant ID', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'alice', { name: 'C' });
        const conv = persistence.createConversation(dirs, 'alice', char.id, 'Test');
        const participant = conv.participants.find(p => p.role === 'character');
        const mock = mockProvider(() => completion);
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withChatServer({
            loadConfig: async () => configuredConfig,
            createProvider: () => mock.provider,
        }, user, async baseUrl => {
            const result = await postChat(baseUrl, {
                messages: [{ role: 'user', content: 'hello' }],
                conversation_id: conv.id,
            });
            assert.equal(result.status, 200);
        });

        const messages = persistence.getMessages(dirs, conv.id);
        assert.equal(messages.length, 2);
        assert.equal(messages[0].role, 'user');
        assert.equal(messages[0].content, 'hello');
        assert.equal(messages[0].participant_id, participant.id);
        assert.equal(messages[1].role, 'character');
        assert.equal(messages[1].content, 'hi there');
        assert.equal(messages[1].participant_id, participant.id);
    } finally {
        tmp.cleanup();
    }
});

test('stream success with conversation_id persists assistant exactly once', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'alice', { name: 'C' });
        const conv = persistence.createConversation(dirs, 'alice', char.id, 'Test');
        const participant = conv.participants.find(p => p.role === 'character');
        const chunks = [sseDelta('hello '), sseDelta('world'), 'data: [DONE]\n\n'];
        const mock = mockStreamProvider(chunks);
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withChatServer({
            loadConfig: async () => configuredConfig,
            createProvider: () => mock.provider,
        }, user, async baseUrl => {
            const result = await postChatStream(baseUrl, {
                messages: [{ role: 'user', content: 'hi' }],
                stream: true,
                conversation_id: conv.id,
            });
            assert.equal(result.status, 200);
            assert.deepEqual(result.records[2], { type: 'done', conversation_id: conv.id });
        });

        const messages = persistence.getMessages(dirs, conv.id);
        assert.equal(messages.length, 2);
        assert.equal(messages[0].role, 'user');
        assert.equal(messages[0].content, 'hi');
        assert.equal(messages[0].participant_id, participant.id);
        assert.equal(messages[1].role, 'character');
        assert.equal(messages[1].content, 'hello world');
        assert.equal(messages[1].participant_id, participant.id);
    } finally {
        tmp.cleanup();
    }
});

test('stream error with conversation_id persists user message but NOT assistant', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'alice', { name: 'C' });
        const conv = persistence.createConversation(dirs, 'alice', char.id, 'Test');
        const participant = conv.participants.find(p => p.role === 'character');
        const chunks = [sseDelta('partial')];
        const mock = mockStreamProvider(chunks, {
            error: new ModelProviderError('upstream failed', { status: 503 }),
        });
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withChatServer({
            loadConfig: async () => configuredConfig,
            createProvider: () => mock.provider,
        }, user, async baseUrl => {
            const result = await postChatStream(baseUrl, {
                messages: [{ role: 'user', content: 'hi' }],
                stream: true,
                conversation_id: conv.id,
            });
            assert.equal(result.status, 200);
            assert.equal(result.records[1].type, 'error');
        });

        const messages = persistence.getMessages(dirs, conv.id);
        assert.equal(messages.length, 1);
        assert.equal(messages[0].role, 'user');
        assert.equal(messages[0].content, 'hi');
        assert.equal(messages[0].participant_id, participant.id);
    } finally {
        tmp.cleanup();
    }
});

test('stream abort with conversation_id persists user message but NOT assistant', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'alice', { name: 'C' });
        const conv = persistence.createConversation(dirs, 'alice', char.id, 'Test');
        const participant = conv.participants.find(p => p.role === 'character');

        // Provider that never resolves (simulates a hang that gets aborted)
        const mock = {
            calls: [],
            provider: {
                chatCompletion: async () => { throw new Error('not expected'); },
                streamChatCompletion: async (messages, options) => {
                    mock.calls.push({ messages, options });
                    return (async function* () {
                        yield new TextEncoder().encode(sseDelta('partial'));
                        // Wait until aborted
                        await new Promise((resolve, reject) => {
                            const onAbort = () => reject(new Error('Aborted'));
                            options.signal.addEventListener('abort', onAbort, { once: true });
                        });
                    })();
                },
            },
        };
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withChatServer({
            loadConfig: async () => configuredConfig,
            createProvider: () => mock.provider,
        }, user, async baseUrl => {
            const controller = new AbortController();
            const response = await fetch(`${baseUrl}/api/openparlor/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: [{ role: 'user', content: 'hi' }],
                    stream: true,
                    conversation_id: conv.id,
                }),
                signal: controller.signal,
            });
            // Read one chunk then abort
            const reader = response.body.getReader();
            await reader.read();
            controller.abort();
            try { await reader.read(); } catch { /* expected */ }
        });

        const messages = persistence.getMessages(dirs, conv.id);
        assert.equal(messages.length, 1);
        assert.equal(messages[0].role, 'user');
        assert.equal(messages[0].content, 'hi');
        assert.equal(messages[0].participant_id, participant.id);
    } finally {
        tmp.cleanup();
    }
});

test('chat with another user\'s conversation returns 403', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'bob', { name: 'C' });
        const conv = persistence.createConversation(dirs, 'bob', char.id, 'BobConv');
        const mock = mockProvider(() => completion);
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withChatServer({
            loadConfig: async () => configuredConfig,
            createProvider: () => mock.provider,
        }, user, async baseUrl => {
            const result = await postChat(baseUrl, {
                messages: [{ role: 'user', content: 'hello' }],
                conversation_id: conv.id,
            });
            assert.equal(result.status, 403);
            assert.deepEqual(result.body, { error: 'Forbidden' });
        });
        assert.equal(mock.calls.length, 0);
    } finally {
        tmp.cleanup();
    }
});

test('chat with non-existent conversation returns 404', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const mock = mockProvider(() => completion);
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withChatServer({
            loadConfig: async () => configuredConfig,
            createProvider: () => mock.provider,
        }, user, async baseUrl => {
            const result = await postChat(baseUrl, {
                messages: [{ role: 'user', content: 'hello' }],
                conversation_id: 'nonexistent-id',
            });
            assert.equal(result.status, 404);
            assert.deepEqual(result.body, { error: 'Conversation not found' });
        });
        assert.equal(mock.calls.length, 0);
    } finally {
        tmp.cleanup();
    }
});
