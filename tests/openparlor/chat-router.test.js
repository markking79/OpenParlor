import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import { createOpenParlorChatRouter } from '../../src/openparlor/chat-router.js';
import { ModelProviderError } from '../../src/openparlor/model-provider.js';
import { estimatePromptTokens, DEFAULT_GENERATION_RESERVE_TOKENS } from '../../src/openparlor/prompt-budget.js';
import { RECENT_WINDOW_MESSAGES } from '../../src/openparlor/conversation-summary.js';

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
            runMemoryExtraction: async () => [],
            runMemoryExtraction: async () => [],
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
            runMemoryExtraction: async () => [],
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

test('group chat directs an addressed character without changing one-on-one flow', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const emma = persistence.createCharacter(dirs, 'alice', { name: 'Emma', system_prompt: 'You are Emma.' });
        const rachel = persistence.createCharacter(dirs, 'alice', { name: 'Rachel', system_prompt: 'You are Rachel.' });
        const conv = persistence.createConversation(dirs, 'alice', emma.id, 'Group');
        const storedConversation = findAndModifyConversation(dirs, conv.id, data => {
            data.participants.push({ id: 'part-rachel', character_id: rachel.id, role: 'character' });
        });
        const rachelParticipant = storedConversation.participants.find(p => p.character_id === rachel.id);
        const mock = mockProvider(() => completion);
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withChatServer({
            loadConfig: async () => configuredConfig,
            createProvider: () => mock.provider,
        }, user, async baseUrl => {
            const result = await postChat(baseUrl, {
                messages: [{ role: 'user', content: 'Rachel, what do you think?' }],
                conversation_id: conv.id,
            });
            assert.equal(result.status, 200);
        });

        assert.ok(mock.calls[0][0].content.includes('You are Rachel.'));
        const messages = persistence.getMessages(dirs, conv.id);
        assert.equal(messages[0].participant_id, rachelParticipant.id);
        assert.equal(messages[1].participant_id, rachelParticipant.id);
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
            assert.deepEqual(result.records[0], { type: 'speaker_start', character_id: char.id, participant_id: participant.id });
            assert.deepEqual(result.records[1], { type: 'delta', text: 'hello ' });
            assert.deepEqual(result.records[2], { type: 'delta', text: 'world' });
            assert.deepEqual(result.records[3], { type: 'speaker_end', character_id: char.id, participant_id: participant.id });
            assert.deepEqual(result.records[4], { type: 'done', conversation_id: conv.id });
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
            assert.equal(result.records[0].type, 'speaker_start');
            assert.equal(result.records[1].type, 'delta');
            assert.equal(result.records[2].type, 'error');
            assert.equal(result.records[2].character_id, char.id);
            assert.equal(result.records[3].type, 'done');
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

// ─── Memory extraction integration tests ─────────────────────────────────────

test('non-stream chat with conversation_id triggers memory extraction after response', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'alice', { name: 'Alice', scenario: 'Tower' });
        const conv = persistence.createConversation(dirs, 'alice', char.id, 'Test');
        const mock = mockProvider(() => completion);
        const user = { profile: { handle: 'alice' }, directories: dirs };

        let extractionParams;
        let extractionDone;
        const extractionPromise = new Promise(resolve => { extractionDone = resolve; });
        const mockExtraction = async (params) => {
            extractionParams = params;
            extractionDone();
            return [];
        };

        await withChatServer({
            loadConfig: async () => configuredConfig,
            createProvider: () => mock.provider,
            runMemoryExtraction: mockExtraction,
        }, user, async baseUrl => {
            const result = await postChat(baseUrl, {
                messages: [{ role: 'user', content: 'I was born in 1990' }],
                conversation_id: conv.id,
            });
            assert.equal(result.status, 200);
            // Wait for extraction to be called
            await extractionPromise;
        });

        assert.ok(extractionParams, 'extraction should have been called');
        assert.equal(extractionParams.owner_id, 'alice');
        assert.equal(extractionParams.character.id, char.id);
        assert.equal(extractionParams.conversation.id, conv.id);
        assert.equal(extractionParams.source_message_id.length > 0, true);
        assert.deepEqual(extractionParams.known_by_character_ids, [char.id]);
        assert.equal(extractionParams.messages.length, 2);
        assert.equal(extractionParams.messages[0].role, 'user');
        assert.equal(extractionParams.messages[0].content, 'I was born in 1990');
        assert.equal(extractionParams.messages[1].role, 'character');
        assert.equal(extractionParams.messages[1].content, 'hi there');
        assert.ok(extractionParams.provider, 'provider should be passed');
    } finally {
        tmp.cleanup();
    }
});

test('stream chat with conversation_id triggers memory extraction after response', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'alice', { name: 'Alice' });
        const conv = persistence.createConversation(dirs, 'alice', char.id, 'Test');
        const chunks = [sseDelta('hello '), sseDelta('world'), 'data: [DONE]\n\n'];
        const mock = mockStreamProvider(chunks);
        const user = { profile: { handle: 'alice' }, directories: dirs };

        let extractionParams;
        let extractionDone;
        const extractionPromise = new Promise(resolve => { extractionDone = resolve; });
        const mockExtraction = async (params) => {
            extractionParams = params;
            extractionDone();
            return [];
        };

        await withChatServer({
            loadConfig: async () => configuredConfig,
            createProvider: () => mock.provider,
            runMemoryExtraction: mockExtraction,
        }, user, async baseUrl => {
            const result = await postChatStream(baseUrl, {
                messages: [{ role: 'user', content: 'hi' }],
                stream: true,
                conversation_id: conv.id,
            });
            assert.equal(result.status, 200);
            await extractionPromise;
        });

        assert.ok(extractionParams, 'extraction should have been called');
        assert.equal(extractionParams.owner_id, 'alice');
        assert.equal(extractionParams.character.id, char.id);
        assert.equal(extractionParams.conversation.id, conv.id);
        assert.equal(extractionParams.messages[1].content, 'hello world');
    } finally {
        tmp.cleanup();
    }
});

test('memory extraction failure does not affect the delivered response', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'alice', { name: 'Alice' });
        const conv = persistence.createConversation(dirs, 'alice', char.id, 'Test');
        const mock = mockProvider(() => completion);
        const user = { profile: { handle: 'alice' }, directories: dirs };

        const mockExtraction = async () => {
            throw new Error('extraction model crashed');
        };

        await withChatServer({
            loadConfig: async () => configuredConfig,
            createProvider: () => mock.provider,
            runMemoryExtraction: mockExtraction,
        }, user, async baseUrl => {
            const result = await postChat(baseUrl, {
                messages: [{ role: 'user', content: 'hello' }],
                conversation_id: conv.id,
            });
            assert.equal(result.status, 200);
            assert.deepEqual(result.body, { ...completion, conversation_id: conv.id });
        });
    } finally {
        tmp.cleanup();
    }
});

test('memory extraction is NOT triggered without conversation_id', async () => {
    const mock = mockProvider(() => completion);
    let extractionCalled = false;
    const mockExtraction = async () => {
        extractionCalled = true;
        return [];
    };

    await withChatServer({
        loadConfig: async () => configuredConfig,
        createProvider: () => mock.provider,
        runMemoryExtraction: mockExtraction,
    }, { profile: { handle: 'alice' }, directories }, async baseUrl => {
        const result = await postChat(baseUrl, { messages: [{ role: 'user', content: 'hello' }] });
        assert.equal(result.status, 200);
    });
    // Give a tick for any async extraction to fire
    await new Promise(r => setImmediate(r));
    assert.equal(extractionCalled, false);
});

test('memory extraction is NOT triggered on provider error', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'alice', { name: 'Alice' });
        const conv = persistence.createConversation(dirs, 'alice', char.id, 'Test');
        const mock = mockProvider(() => {
            throw new ModelProviderError('upstream failed', { status: 503 });
        });
        const user = { profile: { handle: 'alice' }, directories: dirs };

        let extractionCalled = false;
        const mockExtraction = async () => {
            extractionCalled = true;
            return [];
        };

        await withChatServer({
            loadConfig: async () => configuredConfig,
            createProvider: () => mock.provider,
            runMemoryExtraction: mockExtraction,
        }, user, async baseUrl => {
            const result = await postChat(baseUrl, {
                messages: [{ role: 'user', content: 'hello' }],
                conversation_id: conv.id,
            });
            assert.equal(result.status, 503);
        });
        await new Promise(r => setImmediate(r));
        assert.equal(extractionCalled, false);
    } finally {
        tmp.cleanup();
    }
});

test('group conversation extraction records all character participants as known_by and excludes absent characters', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const emma = persistence.createCharacter(dirs, 'alice', { name: 'Emma', system_prompt: 'You are Emma.' });
        const rachel = persistence.createCharacter(dirs, 'alice', { name: 'Rachel', system_prompt: 'You are Rachel.' });
        const sarah = persistence.createCharacter(dirs, 'alice', { name: 'Sarah', system_prompt: 'You are Sarah.' });
        const conv = persistence.createConversation(dirs, 'alice', emma.id, 'Group');
        findAndModifyConversation(dirs, conv.id, data => {
            data.participants.push({ id: 'part-rachel', character_id: rachel.id, role: 'character' });
        });
        const mock = mockProvider(() => completion);
        const user = { profile: { handle: 'alice' }, directories: dirs };

        let extractionParams;
        let extractionDone;
        const extractionPromise = new Promise(resolve => { extractionDone = resolve; });
        const mockExtraction = async (params) => {
            extractionParams = params;
            extractionDone();
            return [];
        };

        await withChatServer({
            loadConfig: async () => configuredConfig,
            createProvider: () => mock.provider,
            runMemoryExtraction: mockExtraction,
        }, user, async baseUrl => {
            const result = await postChat(baseUrl, {
                messages: [{ role: 'user', content: 'Emma, what do you think?' }],
                conversation_id: conv.id,
            });
            assert.equal(result.status, 200);
            await extractionPromise;
        });

        assert.ok(extractionParams, 'extraction should have been called');
        // Both Emma and Rachel are in the conversation → both should be in known_by
        assert.ok(extractionParams.known_by_character_ids.includes(emma.id), 'Emma should be in known_by');
        assert.ok(extractionParams.known_by_character_ids.includes(rachel.id), 'Rachel should be in known_by');
        // Sarah is NOT in the conversation → must not be in known_by
        assert.ok(!extractionParams.known_by_character_ids.includes(sarah.id), 'Sarah must NOT be in known_by');
        // No undefined/null entries
        for (const id of extractionParams.known_by_character_ids) {
            assert.equal(typeof id, 'string');
        }
    } finally {
        tmp.cleanup();
    }
});

test('one-on-one conversation extraction only includes the single character as known_by (privacy regression)', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const alice = persistence.createCharacter(dirs, 'alice', { name: 'Alice', system_prompt: 'You are Alice.' });
        const bob = persistence.createCharacter(dirs, 'alice', { name: 'Bob', system_prompt: 'You are Bob.' });
        const conv = persistence.createConversation(dirs, 'alice', alice.id, 'Solo');
        const mock = mockProvider(() => completion);
        const user = { profile: { handle: 'alice' }, directories: dirs };

        let extractionParams;
        let extractionDone;
        const extractionPromise = new Promise(resolve => { extractionDone = resolve; });
        const mockExtraction = async (params) => {
            extractionParams = params;
            extractionDone();
            return [];
        };

        await withChatServer({
            loadConfig: async () => configuredConfig,
            createProvider: () => mock.provider,
            runMemoryExtraction: mockExtraction,
        }, user, async baseUrl => {
            const result = await postChat(baseUrl, {
                messages: [{ role: 'user', content: 'hello' }],
                conversation_id: conv.id,
            });
            assert.equal(result.status, 200);
            await extractionPromise;
        });

        assert.ok(extractionParams, 'extraction should have been called');
        // Only Alice is in this conversation
        assert.deepEqual(extractionParams.known_by_character_ids, [alice.id]);
        // Bob exists but is not in this conversation
        assert.ok(!extractionParams.known_by_character_ids.includes(bob.id));
    } finally {
        tmp.cleanup();
    }
});

test('retrieves and injects memories into the prompt when conversation_id is provided', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'alice', { name: 'Alice', system_prompt: 'You are Alice.' });
        const conv = persistence.createConversation(dirs, 'alice', char.id, 'Test');
        persistence.createMemory(dirs, 'alice', {
            character_id: char.id,
            content: 'the user was born in 1990',
            type: 'fact',
            importance: 0.8,
            known_by_character_ids: [char.id],
        });
        const mock = mockProvider(() => completion);
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withChatServer({
            loadConfig: async () => configuredConfig,
            createProvider: () => mock.provider,
        }, user, async baseUrl => {
            const result = await postChat(baseUrl, {
                messages: [{ role: 'user', content: 'when was I born' }],
                conversation_id: conv.id,
            });
            assert.equal(result.status, 200);
        });

        const sentMessages = mock.calls[0];
        assert.equal(sentMessages[0].role, 'system');
        assert.ok(sentMessages[0].content.includes('[Character Memory]'));
        assert.ok(sentMessages[0].content.includes('the user was born in 1990'));
        assert.ok(sentMessages[0].content.includes('[/Character Memory]'));
        assert.ok(!sentMessages[0].content.includes('secret-model-key'));
    } finally {
        tmp.cleanup();
    }
});

test('does not inject memories from other characters', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char1 = persistence.createCharacter(dirs, 'alice', { name: 'Alice' });
        const char2 = persistence.createCharacter(dirs, 'alice', { name: 'Bob' });
        const conv = persistence.createConversation(dirs, 'alice', char1.id, 'Test');
        persistence.createMemory(dirs, 'alice', {
            character_id: char2.id,
            content: 'secret only bob knows',
            type: 'fact',
            known_by_character_ids: [char2.id],
        });
        const mock = mockProvider(() => completion);
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withChatServer({
            loadConfig: async () => configuredConfig,
            createProvider: () => mock.provider,
        }, user, async baseUrl => {
            const result = await postChat(baseUrl, {
                messages: [{ role: 'user', content: 'tell me secrets' }],
                conversation_id: conv.id,
            });
            assert.equal(result.status, 200);
        });

        const sentMessages = mock.calls[0];
        assert.ok(!sentMessages[0].content.includes('secret only bob knows'));
    } finally {
        tmp.cleanup();
    }
});

test('memory shared between Emma and Rachel is injected in their fresh conversations but not in Sarah\'s', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const emma = persistence.createCharacter(dirs, 'alice', { name: 'Emma', system_prompt: 'You are Emma.' });
        const rachel = persistence.createCharacter(dirs, 'alice', { name: 'Rachel', system_prompt: 'You are Rachel.' });
        const sarah = persistence.createCharacter(dirs, 'alice', { name: 'Sarah', system_prompt: 'You are Sarah.' });

        // Memory known by Emma and Rachel, but NOT Sarah
        persistence.createMemory(dirs, 'alice', {
            character_id: emma.id,
            content: 'the user codename for the project is phoenix',
            type: 'fact',
            importance: 0.9,
            known_by_character_ids: [emma.id, rachel.id],
        });

        // Fresh one-on-one conversations
        const emmaConv = persistence.createConversation(dirs, 'alice', emma.id, 'Emma Chat');
        const rachelConv = persistence.createConversation(dirs, 'alice', rachel.id, 'Rachel Chat');
        const sarahConv = persistence.createConversation(dirs, 'alice', sarah.id, 'Sarah Chat');

        const mock = mockProvider(() => completion);
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withChatServer({
            loadConfig: async () => configuredConfig,
            createProvider: () => mock.provider,
            runMemoryExtraction: async () => [],
        }, user, async baseUrl => {
            const emmaResult = await postChat(baseUrl, {
                messages: [{ role: 'user', content: 'what is the project codename' }],
                conversation_id: emmaConv.id,
            });
            assert.equal(emmaResult.status, 200);

            const rachelResult = await postChat(baseUrl, {
                messages: [{ role: 'user', content: 'what is the project codename' }],
                conversation_id: rachelConv.id,
            });
            assert.equal(rachelResult.status, 200);

            const sarahResult = await postChat(baseUrl, {
                messages: [{ role: 'user', content: 'what is the project codename' }],
                conversation_id: sarahConv.id,
            });
            assert.equal(sarahResult.status, 200);
        });

        // Emma's system prompt includes the shared memory
        const emmaPrompt = mock.calls[0][0].content;
        assert.ok(emmaPrompt.includes('phoenix'), 'Emma should see the shared memory');

        // Rachel's system prompt includes the shared memory
        const rachelPrompt = mock.calls[1][0].content;
        assert.ok(rachelPrompt.includes('phoenix'), 'Rachel should see the shared memory');

        // Sarah's system prompt does NOT include the shared memory
        const sarahPrompt = mock.calls[2][0].content;
        assert.ok(!sarahPrompt.includes('phoenix'), 'Sarah must NOT see the shared memory');
        assert.ok(!sarahPrompt.includes('codename'), 'Sarah must NOT see the shared memory content');
    } finally {
        tmp.cleanup();
    }
});

// ─── Per-character generation style tests ────────────────────────────────────

test('passes server-stored temperature and max_tokens to the provider for a character', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'alice', { name: 'Styled', temperature: 0.3, max_tokens: 512 });
        const conv = persistence.createConversation(dirs, 'alice', char.id, 'Test');
        const mock = mockProvider(() => completion);
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withChatServer({
            loadConfig: async () => configuredConfig,
            createProvider: () => mock.provider,
            runMemoryExtraction: async () => [],
        }, user, async baseUrl => {
            const result = await postChat(baseUrl, {
                messages: [{ role: 'user', content: 'hello' }],
                conversation_id: conv.id,
            });
            assert.equal(result.status, 200);
        });

        // The provider should have received generation options
        assert.equal(mock.calls.length, 1);
        // mock.calls[0] is the messages array; we need to check options were passed
        // Since mockProvider only captures messages, we verify via a custom provider
    } finally {
        tmp.cleanup();
    }
});

test('passes generation options as second argument to chatCompletion', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'alice', { name: 'Styled', temperature: 0.5, max_tokens: 1024 });
        const conv = persistence.createConversation(dirs, 'alice', char.id, 'Test');

        let receivedOptions;
        const mock = {
            calls: [],
            provider: {
                chatCompletion: async (messages, options) => {
                    mock.calls.push({ messages, options });
                    receivedOptions = options;
                    return completion;
                },
            },
        };
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withChatServer({
            loadConfig: async () => configuredConfig,
            createProvider: () => mock.provider,
            runMemoryExtraction: async () => [],
        }, user, async baseUrl => {
            const result = await postChat(baseUrl, {
                messages: [{ role: 'user', content: 'hello' }],
                conversation_id: conv.id,
            });
            assert.equal(result.status, 200);
        });

        assert.deepEqual(receivedOptions, { temperature: 0.5, max_tokens: 1024 });
    } finally {
        tmp.cleanup();
    }
});

test('does not pass generation options when character has none set', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'alice', { name: 'Plain' });
        const conv = persistence.createConversation(dirs, 'alice', char.id, 'Test');

        let receivedOptions;
        const mock = {
            calls: [],
            provider: {
                chatCompletion: async (messages, options) => {
                    mock.calls.push({ messages, options });
                    receivedOptions = options;
                    return completion;
                },
            },
        };
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

        assert.equal(receivedOptions, undefined);
    } finally {
        tmp.cleanup();
    }
});

test('does not pass generation options in standalone mode (no conversation)', async () => {
    let receivedOptions;
    const mock = {
        calls: [],
        provider: {
            chatCompletion: async (messages, options) => {
                mock.calls.push({ messages, options });
                receivedOptions = options;
                return completion;
            },
        },
    };
    await withChatServer({
        loadConfig: async () => configuredConfig,
        createProvider: () => mock.provider,
    }, { profile: { handle: 'alice' }, directories }, async baseUrl => {
        const result = await postChat(baseUrl, { messages: [{ role: 'user', content: 'hello' }] });
        assert.equal(result.status, 200);
    });
    assert.equal(receivedOptions, undefined);
});

test('ignores client-supplied temperature and max_tokens in chat request body', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'alice', { name: 'Styled', temperature: 0.3, max_tokens: 512 });
        const conv = persistence.createConversation(dirs, 'alice', char.id, 'Test');

        let receivedOptions;
        const mock = {
            calls: [],
            provider: {
                chatCompletion: async (messages, options) => {
                    mock.calls.push({ messages, options });
                    receivedOptions = options;
                    return completion;
                },
            },
        };
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withChatServer({
            loadConfig: async () => configuredConfig,
            createProvider: () => mock.provider,
            runMemoryExtraction: async () => [],
        }, user, async baseUrl => {
            const result = await postChat(baseUrl, {
                messages: [{ role: 'user', content: 'hello' }],
                conversation_id: conv.id,
                temperature: 1.9,
                max_tokens: 99999,
            });
            assert.equal(result.status, 200);
        });

        // Server-stored values win, not client-supplied
        assert.deepEqual(receivedOptions, { temperature: 0.3, max_tokens: 512 });
    } finally {
        tmp.cleanup();
    }
});

test('cross-character isolation: each speaker gets its own generation options', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const emma = persistence.createCharacter(dirs, 'alice', { name: 'Emma', system_prompt: 'You are Emma.', temperature: 0.2, max_tokens: 256 });
        const rachel = persistence.createCharacter(dirs, 'alice', { name: 'Rachel', system_prompt: 'You are Rachel.', temperature: 1.8, max_tokens: 4096 });
        const conv = persistence.createConversation(dirs, 'alice', emma.id, 'Group');
        findAndModifyConversation(dirs, conv.id, data => {
            data.participants.push({ id: 'part-rachel', character_id: rachel.id, role: 'character' });
        });

        const optionsByCall = [];
        const mock = {
            calls: [],
            provider: {
                chatCompletion: async (messages, options) => {
                    mock.calls.push({ messages, options });
                    optionsByCall.push(options);
                    return completion;
                },
            },
        };
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withChatServer({
            loadConfig: async () => configuredConfig,
            createProvider: () => mock.provider,
            runMemoryExtraction: async () => [],
        }, user, async baseUrl => {
            const result = await postChat(baseUrl, {
                messages: [{ role: 'user', content: 'Emma and Rachel, hello' }],
                conversation_id: conv.id,
            });
            assert.equal(result.status, 200);
        });

        assert.equal(mock.calls.length, 2);
        assert.deepEqual(optionsByCall[0], { temperature: 0.2, max_tokens: 256 });
        assert.deepEqual(optionsByCall[1], { temperature: 1.8, max_tokens: 4096 });
    } finally {
        tmp.cleanup();
    }
});

test('passes generation options in stream mode', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'alice', { name: 'Styled', temperature: 0.9, max_tokens: 128 });
        const conv = persistence.createConversation(dirs, 'alice', char.id, 'Test');
        const chunks = [sseDelta('hi'), 'data: [DONE]\n\n'];

        let receivedStreamOptions;
        const mock = {
            calls: [],
            provider: {
                chatCompletion: async () => { throw new Error('not expected'); },
                streamChatCompletion: async (messages, options) => {
                    mock.calls.push({ messages, options });
                    receivedStreamOptions = options;
                    return (async function* () {
                        for (const chunk of chunks) {
                            yield new TextEncoder().encode(chunk);
                        }
                    })();
                },
            },
        };
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
        });

        assert.equal(receivedStreamOptions.temperature, 0.9);
        assert.equal(receivedStreamOptions.max_tokens, 128);
        assert.ok(receivedStreamOptions.signal instanceof AbortSignal);
    } finally {
        tmp.cleanup();
    }
});

// ─── Multi-character speaker director tests ──────────────────────────────────

function findAndModifyConversation(dirs, conversationId, modifier) {
    function search(dir) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                const result = search(fullPath);
                if (result) return result;
            } else if (entry.name.endsWith('.json')) {
                const content = fs.readFileSync(fullPath, 'utf-8');
                if (content.includes(conversationId)) {
                    const data = JSON.parse(content);
                    if (data.id === conversationId) {
                        modifier(data);
                        fs.writeFileSync(fullPath, JSON.stringify(data, null, 2));
                        return data;
                    }
                }
            }
        }
        return null;
    }
    return search(dirs.root);
}

test('multi-character conversation: mentions a character by name and selects that character', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const alice = persistence.createCharacter(dirs, 'alice', { name: 'Alice', system_prompt: 'You are Alice.' });
        const bob = persistence.createCharacter(dirs, 'alice', { name: 'Bob', system_prompt: 'You are Bob.' });
        const conv = persistence.createConversation(dirs, 'alice', alice.id, 'Group Chat');

        // Add Bob as a second character participant
        findAndModifyConversation(dirs, conv.id, data => {
            data.participants.push({ id: 'part-bob', character_id: bob.id, role: 'character' });
        });

        const mock = mockProvider(() => completion);
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withChatServer({
            loadConfig: async () => configuredConfig,
            createProvider: () => mock.provider,
        }, user, async baseUrl => {
            const result = await postChat(baseUrl, {
                messages: [{ role: 'user', content: 'Bob, what do you think?' }],
                conversation_id: conv.id,
            });
            assert.equal(result.status, 200);
        });

        // The prompt should be built for Bob (the mentioned character)
        const sentMessages = mock.calls[0];
        assert.equal(sentMessages[0].role, 'system');
        assert.ok(sentMessages[0].content.includes('You are Bob.'));
        assert.ok(!sentMessages[0].content.includes('You are Alice.'));

        // Message persisted under Bob's participant
        const messages = persistence.getMessages(dirs, conv.id);
        assert.equal(messages.length, 2);
        assert.equal(messages[0].participant_id, 'part-bob');
        assert.equal(messages[1].participant_id, 'part-bob');
    } finally {
        tmp.cleanup();
    }
});

test('multi-character conversation: ambiguous turn consults the director, then falls back to the first character', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const alice = persistence.createCharacter(dirs, 'alice', { name: 'Alice', system_prompt: 'You are Alice.' });
        const bob = persistence.createCharacter(dirs, 'alice', { name: 'Bob', system_prompt: 'You are Bob.' });
        const conv = persistence.createConversation(dirs, 'alice', alice.id, 'Group Chat');

        // Add Bob as a second character participant
        findAndModifyConversation(dirs, conv.id, data => {
            data.participants.push({ id: 'part-bob', character_id: bob.id, role: 'character' });
        });

        const mock = mockProvider(() => completion);
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withChatServer({
            loadConfig: async () => configuredConfig,
            createProvider: () => mock.provider,
            runMemoryExtraction: async () => [],
        }, user, async baseUrl => {
            const result = await postChat(baseUrl, {
                messages: [{ role: 'user', content: 'what should we do today?' }],
                conversation_id: conv.id,
            });
            assert.equal(result.status, 200);
        });

        // STAB-006: the ambiguous turn makes one bounded director call first
        // (mock.calls[0]); its unparseable output falls back to the
        // least-recently-spoken character, which with no history is the
        // first participant (Alice). The real response call is second.
        assert.equal(mock.calls.length, 2);
        assert.ok(mock.calls[0][0].content.toLowerCase().includes('speaker director'),
            'the first call must be the director decision prompt');
        const sentMessages = mock.calls[1];
        assert.ok(sentMessages[0].content.includes('You are Alice.'));
        assert.ok(!sentMessages[0].content.includes('You are Bob.'));
    } finally {
        tmp.cleanup();
    }
});

test('multi-character conversation: director decides the speaker when its output is valid', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const alice = persistence.createCharacter(dirs, 'alice', { name: 'Alice', system_prompt: 'You are Alice.' });
        const bob = persistence.createCharacter(dirs, 'alice', { name: 'Bob', system_prompt: 'You are Bob.' });
        const conv = persistence.createConversation(dirs, 'alice', alice.id, 'Group Chat');
        const storedConversation = findAndModifyConversation(dirs, conv.id, data => {
            data.participants.push({ id: 'part-bob', character_id: bob.id, role: 'character' });
        });
        const bobParticipant = storedConversation.participants.find(p => p.character_id === bob.id);

        const mock = {
            calls: [],
            provider: {
                chatCompletion: async messages => {
                    mock.calls.push(messages);
                    const isDirector = messages[0].content.toLowerCase().includes('speaker director');
                    return isDirector
                        ? { choices: [{ message: { content: '{"speakers": ["' + bob.id + '"]}' } }] }
                        : completion;
                },
            },
        };
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withChatServer({
            loadConfig: async () => configuredConfig,
            createProvider: () => mock.provider,
            runMemoryExtraction: async () => [],
        }, user, async baseUrl => {
            const result = await postChat(baseUrl, {
                messages: [{ role: 'user', content: 'what should we do today?' }],
                conversation_id: conv.id,
            });
            assert.equal(result.status, 200);
        });

        assert.equal(mock.calls.length, 2, 'director call plus one response call');
        const sentMessages = mock.calls[1];
        assert.ok(sentMessages[0].content.includes('You are Bob.'), 'the director-picked speaker must be prompted');
        assert.ok(!sentMessages[0].content.includes('You are Alice.'));
        const messages = persistence.getMessages(dirs, conv.id);
        assert.equal(messages.length, 2);
        assert.equal(messages[1].participant_id, bobParticipant.id, 'the reply must be persisted under the chosen speaker');
    } finally {
        tmp.cleanup();
    }
});

test('multi-character conversation: invalid director IDs never reach the router', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const alice = persistence.createCharacter(dirs, 'alice', { name: 'Alice', system_prompt: 'You are Alice.' });
        const bob = persistence.createCharacter(dirs, 'alice', { name: 'Bob', system_prompt: 'You are Bob.' });
        const conv = persistence.createConversation(dirs, 'alice', alice.id, 'Group Chat');
        findAndModifyConversation(dirs, conv.id, data => {
            data.participants.push({ id: 'part-bob', character_id: bob.id, role: 'character' });
        });

        const mock = {
            calls: [],
            provider: {
                chatCompletion: async messages => {
                    mock.calls.push(messages);
                    const isDirector = messages[0].content.toLowerCase().includes('speaker director');
                    // The model tries to direct speech to a character that is
                    // not in this conversation.
                    return isDirector
                        ? { choices: [{ message: { content: '{"speakers": ["injected-character-id"]}' } }] }
                        : completion;
                },
            },
        };
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withChatServer({
            loadConfig: async () => configuredConfig,
            createProvider: () => mock.provider,
            runMemoryExtraction: async () => [],
        }, user, async baseUrl => {
            const result = await postChat(baseUrl, {
                messages: [{ role: 'user', content: 'what should we do today?' }],
                conversation_id: conv.id,
            });
            assert.equal(result.status, 200);
        });

        // The forged ID is rejected; the deterministic fallback picks Alice.
        assert.equal(mock.calls.length, 2);
        const sentMessages = mock.calls[1];
        assert.ok(sentMessages[0].content.includes('You are Alice.'));
        assert.ok(!sentMessages[0].content.includes('injected-character-id'));
    } finally {
        tmp.cleanup();
    }
});

test('multi-character conversation: one-on-one behavior is preserved for single-character conversations', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const alice = persistence.createCharacter(dirs, 'alice', { name: 'Alice', system_prompt: 'You are Alice.' });
        const conv = persistence.createConversation(dirs, 'alice', alice.id, 'Solo Chat');
        const participant = conv.participants.find(p => p.role === 'character');

        const mock = mockProvider(() => completion);
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withChatServer({
            loadConfig: async () => configuredConfig,
            createProvider: () => mock.provider,
        }, user, async baseUrl => {
            const result = await postChat(baseUrl, {
                messages: [{ role: 'user', content: 'hello Alice' }],
                conversation_id: conv.id,
            });
            assert.equal(result.status, 200);
        });

        const sentMessages = mock.calls[0];
        assert.ok(sentMessages[0].content.includes('You are Alice.'));

        const messages = persistence.getMessages(dirs, conv.id);
        assert.equal(messages.length, 2);
        assert.equal(messages[0].participant_id, participant.id);
        assert.equal(messages[1].participant_id, participant.id);
    } finally {
        tmp.cleanup();
    }
});

test('multi-character conversation: safe no-speaker behavior when character record is missing', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const alice = persistence.createCharacter(dirs, 'alice', { name: 'Alice', system_prompt: 'You are Alice.' });
        const conv = persistence.createConversation(dirs, 'alice', alice.id, 'Group Chat');

        // Add a participant referencing a non-existent character
        findAndModifyConversation(dirs, conv.id, data => {
            data.participants.push({ id: 'part-ghost', character_id: 'nonexistent-char-id', role: 'character' });
        });

        const mock = mockProvider(() => completion);
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withChatServer({
            loadConfig: async () => configuredConfig,
            createProvider: () => mock.provider,
        }, user, async baseUrl => {
            // Mention the ghost character by a name that won't match (no record)
            // Director will fall back to first valid character (Alice)
            const result = await postChat(baseUrl, {
                messages: [{ role: 'user', content: 'hello everyone' }],
                conversation_id: conv.id,
            });
            // Should still work — the ghost is filtered out by .filter(Boolean) in charRecords
            assert.equal(result.status, 200);
        });

        // Alice (first valid) should be selected
        const sentMessages = mock.calls[0];
        assert.ok(sentMessages[0].content.includes('You are Alice.'));
    } finally {
        tmp.cleanup();
    }
});

// ─── Multi-speaker sequential generation tests ───────────────────────────────

test('multi-speaker non-stream: each speaker gets independent prompt and persisted message', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const emma = persistence.createCharacter(dirs, 'alice', { name: 'Emma', system_prompt: 'You are Emma.' });
        const rachel = persistence.createCharacter(dirs, 'alice', { name: 'Rachel', system_prompt: 'You are Rachel.' });
        const conv = persistence.createConversation(dirs, 'alice', emma.id, 'Group');
        const storedConversation = findAndModifyConversation(dirs, conv.id, data => {
            data.participants.push({ id: 'part-rachel', character_id: rachel.id, role: 'character' });
        });
        const emmaParticipant = storedConversation.participants.find(p => p.character_id === emma.id);
        const rachelParticipant = storedConversation.participants.find(p => p.character_id === rachel.id);

        const mock = mockProvider(() => completion);
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withChatServer({
            loadConfig: async () => configuredConfig,
            createProvider: () => mock.provider,
            runMemoryExtraction: async () => [],
        }, user, async baseUrl => {
            const result = await postChat(baseUrl, {
                messages: [{ role: 'user', content: 'Emma and Rachel, what do you both think?' }],
                conversation_id: conv.id,
            });
            assert.equal(result.status, 200);
            assert.equal(result.body.conversation_id, conv.id);
            assert.equal(result.body.responses.length, 2);
            assert.equal(result.body.responses[0].character_id, emma.id);
            assert.equal(result.body.responses[0].participant_id, emmaParticipant.id);
            assert.equal(result.body.responses[0].content, 'hi there');
            assert.equal(result.body.responses[1].character_id, rachel.id);
            assert.equal(result.body.responses[1].participant_id, rachelParticipant.id);
            assert.equal(result.body.responses[1].content, 'hi there');
        });

        // Each speaker got their own prompt with their own character
        assert.equal(mock.calls.length, 2);
        assert.ok(mock.calls[0][0].content.includes('You are Emma.'));
        assert.ok(!mock.calls[0][0].content.includes('You are Rachel.'));
        assert.ok(mock.calls[1][0].content.includes('You are Rachel.'));
        assert.ok(!mock.calls[1][0].content.includes('You are Emma.'));

        // Messages persisted under correct participants
        const messages = persistence.getMessages(dirs, conv.id);
        assert.equal(messages.length, 3);
        assert.equal(messages[0].role, 'user');
        assert.equal(messages[1].role, 'character');
        assert.equal(messages[1].participant_id, emmaParticipant.id);
        assert.equal(messages[2].role, 'character');
        assert.equal(messages[2].participant_id, rachelParticipant.id);
    } finally {
        tmp.cleanup();
    }
});

test('multi-speaker non-stream: error for one speaker does not prevent others', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const emma = persistence.createCharacter(dirs, 'alice', { name: 'Emma', system_prompt: 'You are Emma.' });
        const rachel = persistence.createCharacter(dirs, 'alice', { name: 'Rachel', system_prompt: 'You are Rachel.' });
        const conv = persistence.createConversation(dirs, 'alice', emma.id, 'Group');
        const storedConversation = findAndModifyConversation(dirs, conv.id, data => {
            data.participants.push({ id: 'part-rachel', character_id: rachel.id, role: 'character' });
        });
        const rachelParticipant = storedConversation.participants.find(p => p.character_id === rachel.id);

        let callCount = 0;
        const mock = mockProvider(() => {
            callCount++;
            if (callCount === 1) {
                throw new ModelProviderError('upstream failed', { status: 503 });
            }
            return completion;
        });
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withChatServer({
            loadConfig: async () => configuredConfig,
            createProvider: () => mock.provider,
            runMemoryExtraction: async () => [],
        }, user, async baseUrl => {
            const result = await postChat(baseUrl, {
                messages: [{ role: 'user', content: 'Emma and Rachel, hello' }],
                conversation_id: conv.id,
            });
            assert.equal(result.status, 200);
            assert.equal(result.body.responses.length, 2);
            // First speaker failed
            assert.equal(result.body.responses[0].character_id, emma.id);
            assert.equal(result.body.responses[0].error, 'Chat completion failed');
            // Second speaker succeeded
            assert.equal(result.body.responses[1].character_id, rachel.id);
            assert.equal(result.body.responses[1].content, 'hi there');
        });

        // Only Rachel's message persisted (plus user)
        const messages = persistence.getMessages(dirs, conv.id);
        assert.equal(messages.length, 2);
        assert.equal(messages[0].role, 'user');
        assert.equal(messages[1].role, 'character');
        assert.equal(messages[1].participant_id, rachelParticipant.id);
    } finally {
        tmp.cleanup();
    }
});

test('multi-speaker stream: sequential speaker_start/delta/speaker_end framing', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const emma = persistence.createCharacter(dirs, 'alice', { name: 'Emma', system_prompt: 'You are Emma.' });
        const rachel = persistence.createCharacter(dirs, 'alice', { name: 'Rachel', system_prompt: 'You are Rachel.' });
        const conv = persistence.createConversation(dirs, 'alice', emma.id, 'Group');
        const storedConversation = findAndModifyConversation(dirs, conv.id, data => {
            data.participants.push({ id: 'part-rachel', character_id: rachel.id, role: 'character' });
        });
        const emmaParticipant = storedConversation.participants.find(p => p.character_id === emma.id);
        const rachelParticipant = storedConversation.participants.find(p => p.character_id === rachel.id);

        let callCount = 0;
        const encoder = new TextEncoder();
        const mock = {
            calls: [],
            provider: {
                chatCompletion: async () => { throw new Error('not expected'); },
                streamChatCompletion: async (messages, options) => {
                    callCount++;
                    mock.calls.push({ messages, options });
                    const text = callCount === 1 ? 'Emma says hi' : 'Rachel waves';
                    return (async function* () {
                        yield encoder.encode(sseDelta(text));
                        yield encoder.encode('data: [DONE]\n\n');
                    })();
                },
            },
        };
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withChatServer({
            loadConfig: async () => configuredConfig,
            createProvider: () => mock.provider,
            runMemoryExtraction: async () => [],
        }, user, async baseUrl => {
            const result = await postChatStream(baseUrl, {
                messages: [{ role: 'user', content: 'Emma and Rachel, hello everyone' }],
                stream: true,
                conversation_id: conv.id,
            });
            assert.equal(result.status, 200);
            assert.deepEqual(result.records, [
                { type: 'speaker_start', character_id: emma.id, participant_id: emmaParticipant.id },
                { type: 'delta', text: 'Emma says hi' },
                { type: 'speaker_end', character_id: emma.id, participant_id: emmaParticipant.id },
                { type: 'speaker_start', character_id: rachel.id, participant_id: rachelParticipant.id },
                { type: 'delta', text: 'Rachel waves' },
                { type: 'speaker_end', character_id: rachel.id, participant_id: rachelParticipant.id },
                { type: 'done', conversation_id: conv.id },
            ]);
        });

        // Each speaker got their own prompt
        assert.equal(mock.calls.length, 2);
        assert.ok(mock.calls[0].messages[0].content.includes('You are Emma.'));
        assert.ok(mock.calls[1].messages[0].content.includes('You are Rachel.'));

        // Both messages persisted
        const messages = persistence.getMessages(dirs, conv.id);
        assert.equal(messages.length, 3);
        assert.equal(messages[1].participant_id, emmaParticipant.id);
        assert.equal(messages[1].content, 'Emma says hi');
        assert.equal(messages[2].participant_id, rachelParticipant.id);
        assert.equal(messages[2].content, 'Rachel waves');
    } finally {
        tmp.cleanup();
    }
});

test('multi-speaker stream: error for one speaker does not corrupt earlier output', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const emma = persistence.createCharacter(dirs, 'alice', { name: 'Emma', system_prompt: 'You are Emma.' });
        const rachel = persistence.createCharacter(dirs, 'alice', { name: 'Rachel', system_prompt: 'You are Rachel.' });
        const conv = persistence.createConversation(dirs, 'alice', emma.id, 'Group');
        const storedConversation = findAndModifyConversation(dirs, conv.id, data => {
            data.participants.push({ id: 'part-rachel', character_id: rachel.id, role: 'character' });
        });
        const emmaParticipant = storedConversation.participants.find(p => p.character_id === emma.id);
        const rachelParticipant = storedConversation.participants.find(p => p.character_id === rachel.id);

        let callCount = 0;
        const encoder = new TextEncoder();
        const mock = {
            calls: [],
            provider: {
                chatCompletion: async () => { throw new Error('not expected'); },
                streamChatCompletion: async (messages, options) => {
                    callCount++;
                    mock.calls.push({ messages, options });
                    if (callCount === 1) {
                        return (async function* () {
                            yield encoder.encode(sseDelta('Emma responds'));
                            yield encoder.encode('data: [DONE]\n\n');
                        })();
                    }
                    // Second speaker fails
                    return (async function* () {
                        yield encoder.encode(sseDelta('partial'));
                        throw new ModelProviderError('upstream timeout', { status: 503 });
                    })();
                },
            },
        };
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withChatServer({
            loadConfig: async () => configuredConfig,
            createProvider: () => mock.provider,
            runMemoryExtraction: async () => [],
        }, user, async baseUrl => {
            const result = await postChatStream(baseUrl, {
                messages: [{ role: 'user', content: 'Emma and Rachel, hello' }],
                stream: true,
                conversation_id: conv.id,
            });
            assert.equal(result.status, 200);
            // Emma's output is intact
            assert.deepEqual(result.records[0], { type: 'speaker_start', character_id: emma.id, participant_id: emmaParticipant.id });
            assert.deepEqual(result.records[1], { type: 'delta', text: 'Emma responds' });
            assert.deepEqual(result.records[2], { type: 'speaker_end', character_id: emma.id, participant_id: emmaParticipant.id });
            // Rachel's error is isolated
            assert.deepEqual(result.records[3], { type: 'speaker_start', character_id: rachel.id, participant_id: rachelParticipant.id });
            assert.deepEqual(result.records[4], { type: 'delta', text: 'partial' });
            assert.equal(result.records[5].type, 'error');
            assert.equal(result.records[5].error, 'upstream timeout');
            assert.equal(result.records[5].character_id, rachel.id);
            assert.deepEqual(result.records[6], { type: 'done', conversation_id: conv.id });
        });

        // Emma's message persisted, Rachel's is not
        const messages = persistence.getMessages(dirs, conv.id);
        assert.equal(messages.length, 2);
        assert.equal(messages[0].role, 'user');
        assert.equal(messages[1].role, 'character');
        assert.equal(messages[1].participant_id, emmaParticipant.id);
        assert.equal(messages[1].content, 'Emma responds');
    } finally {
        tmp.cleanup();
    }
});

test('single-speaker stream: speaker_start and speaker_end frame the single response', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'alice', { name: 'Alice', system_prompt: 'You are Alice.' });
        const conv = persistence.createConversation(dirs, 'alice', char.id, 'Solo');
        const participant = conv.participants.find(p => p.role === 'character');
        const chunks = [sseDelta('hello '), sseDelta('world'), 'data: [DONE]\n\n'];
        const mock = mockStreamProvider(chunks);
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withChatServer({
            loadConfig: async () => configuredConfig,
            createProvider: () => mock.provider,
            runMemoryExtraction: async () => [],
        }, user, async baseUrl => {
            const result = await postChatStream(baseUrl, {
                messages: [{ role: 'user', content: 'hi' }],
                stream: true,
                conversation_id: conv.id,
            });
            assert.equal(result.status, 200);
            assert.deepEqual(result.records, [
                { type: 'speaker_start', character_id: char.id, participant_id: participant.id },
                { type: 'delta', text: 'hello ' },
                { type: 'delta', text: 'world' },
                { type: 'speaker_end', character_id: char.id, participant_id: participant.id },
                { type: 'done', conversation_id: conv.id },
            ]);
        });

        const messages = persistence.getMessages(dirs, conv.id);
        assert.equal(messages.length, 2);
        assert.equal(messages[1].participant_id, participant.id);
        assert.equal(messages[1].content, 'hello world');
    } finally {
        tmp.cleanup();
    }
});

test('stream without conversation_id: no speaker_start or speaker_end records', async () => {
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
});

test('memory extraction is NOT triggered on stream error', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'alice', { name: 'Alice' });
        const conv = persistence.createConversation(dirs, 'alice', char.id, 'Test');
        const chunks = [sseDelta('partial')];
        const mock = mockStreamProvider(chunks, {
            error: new ModelProviderError('upstream failed', { status: 503 }),
        });
        const user = { profile: { handle: 'alice' }, directories: dirs };

        let extractionCalled = false;
        const mockExtraction = async () => {
            extractionCalled = true;
            return [];
        };

        await withChatServer({
            loadConfig: async () => configuredConfig,
            createProvider: () => mock.provider,
            runMemoryExtraction: mockExtraction,
        }, user, async baseUrl => {
            const result = await postChatStream(baseUrl, {
                messages: [{ role: 'user', content: 'hi' }],
                stream: true,
                conversation_id: conv.id,
            });
            assert.equal(result.status, 200);
            const errorRecord = result.records.find(r => r.type === 'error');
            assert.ok(errorRecord, 'should have an error record');
        });
        await new Promise(r => setImmediate(r));
        assert.equal(extractionCalled, false);
    } finally {
        tmp.cleanup();
    }
});

// ─── QWEN-GROUP-001: group chat correctness ──────────────────────────────────

test('group stream with whole-group cue: each speaker prompted, user persisted once, done record', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const doug = persistence.createCharacter(dirs, 'alice', { name: 'Doug', system_prompt: 'You are Doug.' });
        const monica = persistence.createCharacter(dirs, 'alice', { name: 'Monica', system_prompt: 'You are Monica.' });
        const conv = persistence.createConversation(dirs, 'alice', doug.id, 'Group');
        const storedConversation = findAndModifyConversation(dirs, conv.id, data => {
            data.participants.push({ id: 'part-monica', character_id: monica.id, role: 'character' });
        });
        const dougParticipant = storedConversation.participants.find(p => p.character_id === doug.id);
        const monicaParticipant = storedConversation.participants.find(p => p.character_id === monica.id);

        let callCount = 0;
        const encoder = new TextEncoder();
        const mock = {
            calls: [],
            provider: {
                chatCompletion: async () => { throw new Error('not expected'); },
                streamChatCompletion: async (messages) => {
                    callCount++;
                    mock.calls.push(messages);
                    const text = callCount === 1 ? 'Doug says hello' : 'Monica says hello';
                    return (async function* () {
                        yield encoder.encode(sseDelta(text));
                        yield encoder.encode('data: [DONE]\n\n');
                    })();
                },
            },
        };
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withChatServer({
            loadConfig: async () => configuredConfig,
            createProvider: () => mock.provider,
            runMemoryExtraction: async () => [],
        }, user, async baseUrl => {
            const result = await postChatStream(baseUrl, {
                messages: [{ role: 'user', content: 'Hey, how is everyone doing?' }],
                stream: true,
                conversation_id: conv.id,
            });
            assert.equal(result.status, 200);
            assert.deepEqual(result.records, [
                { type: 'speaker_start', character_id: doug.id, participant_id: dougParticipant.id },
                { type: 'delta', text: 'Doug says hello' },
                { type: 'speaker_end', character_id: doug.id, participant_id: dougParticipant.id },
                { type: 'speaker_start', character_id: monica.id, participant_id: monicaParticipant.id },
                { type: 'delta', text: 'Monica says hello' },
                { type: 'speaker_end', character_id: monica.id, participant_id: monicaParticipant.id },
                { type: 'done', conversation_id: conv.id },
            ]);
        });

        assert.equal(mock.calls.length, 2, 'provider should be called once per selected speaker');
        assert.ok(mock.calls[0][0].content.includes('You are Doug.'));
        assert.ok(!mock.calls[0][0].content.includes('You are Monica.'), 'Doug prompt must not carry Monica persona');
        assert.ok(mock.calls[1][0].content.includes('You are Monica.'));
        assert.ok(!mock.calls[1][0].content.includes('You are Doug.'), 'Monica prompt must not carry Doug persona');

        const messages = persistence.getMessages(dirs, conv.id);
        assert.equal(messages.filter(m => m.role === 'user').length, 1, 'user message must be persisted exactly once');
        assert.equal(messages[0].role, 'user');
        assert.equal(messages[0].content, 'Hey, how is everyone doing?');
        assert.equal(messages.length, 3);
        assert.equal(messages[1].participant_id, dougParticipant.id);
        assert.equal(messages[2].participant_id, monicaParticipant.id);
    } finally {
        tmp.cleanup();
    }
});

test('group prompt lists actual participant names instead of raw records', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const doug = persistence.createCharacter(dirs, 'alice', { name: 'Doug', system_prompt: 'You are Doug.' });
        const monica = persistence.createCharacter(dirs, 'alice', { name: 'Monica', system_prompt: 'You are Monica.' });
        const conv = persistence.createConversation(dirs, 'alice', doug.id, 'Group');
        findAndModifyConversation(dirs, conv.id, data => {
            data.participants.push({ id: 'part-monica', character_id: monica.id, role: 'character' });
        });
        const mock = mockProvider(() => completion);
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withChatServer({
            loadConfig: async () => configuredConfig,
            createProvider: () => mock.provider,
            runMemoryExtraction: async () => [],
        }, user, async baseUrl => {
            const result = await postChat(baseUrl, {
                messages: [{ role: 'user', content: 'Doug and Monica, answer' }],
                conversation_id: conv.id,
            });
            assert.equal(result.status, 200);
        });

        assert.equal(mock.calls.length, 2);
        const sys = mock.calls[0][0].content;
        assert.ok(sys.includes('Present participants in this conversation: Doug, Monica'),
            'system prompt must contain readable participant names');
        assert.ok(!sys.includes('[object Object]'), 'system prompt must not stringify raw participant records');
    } finally {
        tmp.cleanup();
    }
});

test('provider prompt contains persisted history and new question exactly once each', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const doug = persistence.createCharacter(dirs, 'alice', { name: 'Doug', system_prompt: 'You are Doug.' });
        const conv = persistence.createConversation(dirs, 'alice', doug.id, 'Chat');
        const storedConversation = persistence.getConversation(dirs, conv.id);
        const dougParticipant = storedConversation.participants.find(p => p.character_id === doug.id);
        // Pre-persisted history from an earlier turn.
        persistence.appendMessage(dirs, conv.id, dougParticipant.id, 'old question', 'user');
        persistence.appendMessage(dirs, conv.id, dougParticipant.id, 'old response', 'character');
        const mock = mockProvider(() => completion);
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withChatServer({
            loadConfig: async () => configuredConfig,
            createProvider: () => mock.provider,
            runMemoryExtraction: async () => [],
        }, user, async baseUrl => {
            const result = await postChat(baseUrl, {
                messages: [{ role: 'user', content: 'new question' }],
                conversation_id: conv.id,
            });
            assert.equal(result.status, 200);
        });

        const prompt = mock.calls[0];
        const count = text => prompt.filter(m => m.content === text).length;
        assert.equal(count('old question'), 1, 'persisted user turn must appear exactly once');
        assert.equal(count('old response'), 1, 'persisted character turn must appear exactly once');
        assert.equal(count('new question'), 1, 'new user turn must appear exactly once');
    } finally {
        tmp.cleanup();
    }
});

test('group prompt keeps speaker identity of persisted history for the selected speaker', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const doug = persistence.createCharacter(dirs, 'alice', { name: 'Doug', system_prompt: 'You are Doug.' });
        const monica = persistence.createCharacter(dirs, 'alice', { name: 'Monica', system_prompt: 'You are Monica.' });
        const conv = persistence.createConversation(dirs, 'alice', doug.id, 'Group');
        findAndModifyConversation(dirs, conv.id, data => {
            data.participants.push({ id: 'part-monica', character_id: monica.id, role: 'character' });
        });
        const conversation = persistence.getConversation(dirs, conv.id);
        const dougParticipant = conversation.participants.find(p => p.character_id === doug.id);
        const monicaParticipant = conversation.participants.find(p => p.character_id === monica.id);
        // Pre-persisted history from an earlier group turn.
        persistence.appendMessage(dirs, conv.id, dougParticipant.id, 'Hello everyone', 'user');
        persistence.appendMessage(dirs, conv.id, dougParticipant.id, "Hi, I am Doug", 'character');
        persistence.appendMessage(dirs, conv.id, monicaParticipant.id, "Hi, I am Monica", 'character');
        const mock = mockProvider(() => completion);
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withChatServer({
            loadConfig: async () => configuredConfig,
            createProvider: () => mock.provider,
            runMemoryExtraction: async () => [],
        }, user, async baseUrl => {
            const result = await postChat(baseUrl, {
                messages: [{ role: 'user', content: 'Monica, what are you working on today?' }],
                conversation_id: conv.id,
            });
            assert.equal(result.status, 200);
        });

        assert.equal(mock.calls.length, 1, 'only Monica should be selected');
        const prompt = mock.calls[0];
        const system = prompt[0].content;
        assert.ok(system.includes('You are Monica.'));
        assert.ok(system.includes('Present participants in this conversation: Doug, Monica'));
        assert.ok(!system.includes('[object Object]'));

        const monicaLine = prompt.find(m => m.content === "Hi, I am Monica");
        assert.ok(monicaLine, 'Monica line must be present');
        assert.equal(monicaLine.role, 'assistant', 'the target character\'s own line must be an assistant message');

        const dougLine = prompt.find(m => m.content.includes("Hi, I am Doug"));
        assert.ok(dougLine, 'Doug line must be present');
        assert.equal(dougLine.role, 'user', 'another character\'s line must not be an assistant message');
        assert.ok(dougLine.content.includes('[Doug said to the group]'), 'Doug line must be attributed to Doug');
        assert.ok(!prompt.some(m => m.role === 'assistant' && m.content.includes("Hi, I am Doug")));
    } finally {
        tmp.cleanup();
    }
});

// --- STAB-005: rolling summary + prompt budget integration ----------------

test('POST /chat injects the stored rolling summary and drops the summarized prefix from raw history', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'alice', { name: 'C' });
        const conv = persistence.createConversation(dirs, 'alice', char.id, 'Test');
        const participant = conv.participants.find(p => p.role === 'character');
        // 26 stored messages; the first 16 are covered by the rolling summary.
        for (let i = 0; i < 26; i++) {
            const isUser = i % 2 === 0;
            persistence.appendMessage(dirs, conv.id, participant.id, isUser ? `u${i}` : `c${i}`, isUser ? 'user' : 'character');
        }
        persistence.updateConversation(dirs, conv.id, {
            summary: 'They met at the market and agreed to trade.',
            summary_message_count: 16,
        });
        const mock = mockProvider(() => completion);
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withChatServer({
            loadConfig: async () => configuredConfig,
            createProvider: () => mock.provider,
            runMemoryExtraction: async () => [],
        }, user, async baseUrl => {
            const result = await postChat(baseUrl, {
                messages: [{ role: 'user', content: 'new turn' }],
                conversation_id: conv.id,
            });
            assert.equal(result.status, 200);
        });

        const prompt = mock.calls[0];
        const system = prompt[0].content;
        assert.ok(system.includes('[Conversation Summary]'), 'summary section start delimiter');
        assert.ok(system.includes('They met at the market and agreed to trade.'), 'summary text is injected');
        assert.ok(system.includes('[/Conversation Summary]'), 'summary section end delimiter');

        // System + recent raw window + the new user turn.
        assert.equal(prompt.length, 1 + RECENT_WINDOW_MESSAGES + 1);
        assert.equal(prompt[1].content, 'u16', 'window starts right after the summarized prefix');
        assert.equal(prompt[1 + RECENT_WINDOW_MESSAGES - 1].content, 'c25');
        assert.equal(prompt[prompt.length - 1].content, 'new turn');

        const serialized = prompt.map(m => m.content).join('\n');
        assert.ok(!serialized.includes('c15'), 'summarized prefix must not be resent raw');
        assert.ok(!serialized.includes('u0'), 'summarized prefix must not be resent raw');
    } finally {
        tmp.cleanup();
    }
});

test('POST /chat trims the assembled prompt to the configured model context with the generation reserve', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'alice', { name: 'C' });
        const conv = persistence.createConversation(dirs, 'alice', char.id, 'Test');
        const participant = conv.participants.find(p => p.role === 'character');
        // 40 oversized history messages (~505 estimated tokens each); the
        // legacy 20-message window would far exceed a 768-token context.
        for (let i = 0; i < 40; i++) {
            const isUser = i % 2 === 0;
            persistence.appendMessage(dirs, conv.id, participant.id, `x${'x'.repeat(2000)}-${i}`, isUser ? 'user' : 'character');
        }
        const smallContextConfig = {
            ...configuredConfig,
            model: { ...configuredConfig.model, maxContextTokens: 768 },
        };
        const mock = mockProvider(() => completion);
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withChatServer({
            loadConfig: async () => smallContextConfig,
            createProvider: () => mock.provider,
            runMemoryExtraction: async () => [],
        }, user, async baseUrl => {
            const result = await postChat(baseUrl, {
                messages: [{ role: 'user', content: 'new turn' }],
                conversation_id: conv.id,
            });
            assert.equal(result.status, 200);
        });

        const prompt = mock.calls[0];
        assert.ok(
            estimatePromptTokens(prompt) + DEFAULT_GENERATION_RESERVE_TOKENS <= 768,
            'prompt plus generation reserve must fit the configured context',
        );
        assert.equal(prompt[0].role, 'system', 'system prompt is never trimmed');
        assert.equal(prompt[prompt.length - 1].content, 'new turn', 'the newest user turn is never trimmed');
        // With the 4096-token fallback several oversized history messages would
        // survive, so exactly [system, newest turn] proves the configured
        // 768-token context took precedence.
        assert.equal(prompt.length, 2, 'oversized history is trimmed away');
    } finally {
        tmp.cleanup();
    }
});

test('standalone POST /chat applies the configured prompt budget to browser messages', async () => {
    const smallContextConfig = {
        ...configuredConfig,
        model: { ...configuredConfig.model, maxContextTokens: 768 },
    };
    const mock = mockProvider(() => completion);
    await withChatServer({
        loadConfig: async () => smallContextConfig,
        createProvider: () => mock.provider,
    }, { profile: { handle: 'alice' }, directories }, async baseUrl => {
        const result = await postChat(baseUrl, {
            messages: [
                { role: 'user', content: 'y'.repeat(2000) },
                { role: 'user', content: 'new turn' },
            ],
        });
        assert.equal(result.status, 200);
    });

    const prompt = mock.calls[0];
    assert.ok(estimatePromptTokens(prompt) + DEFAULT_GENERATION_RESERVE_TOKENS <= 768);
    assert.equal(prompt.length, 1, 'the oversized older message is trimmed');
    assert.equal(prompt[0].content, 'new turn');
});

test('POST /chat schedules a fire-and-forget rolling summary refresh after a completed turn', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'alice', { name: 'C' });
        const conv = persistence.createConversation(dirs, 'alice', char.id, 'Test');
        const participant = conv.participants.find(p => p.role === 'character');
        for (let i = 0; i < 26; i++) {
            const isUser = i % 2 === 0;
            persistence.appendMessage(dirs, conv.id, participant.id, isUser ? `u${i}` : `c${i}`, isUser ? 'user' : 'character');
        }
        persistence.updateConversation(dirs, conv.id, {
            summary: 'Old rolling summary.',
            summary_message_count: 10,
        });
        const mock = mockProvider(messages => {
            if (messages[0] && typeof messages[0].content === 'string'
                && messages[0].content.startsWith('You are a conversation summarizer')) {
                return { choices: [{ message: { content: 'Fresh rolling summary.' } }] };
            }
            return completion;
        });
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withChatServer({
            loadConfig: async () => configuredConfig,
            createProvider: () => mock.provider,
            runMemoryExtraction: async () => [],
        }, user, async baseUrl => {
            const result = await postChat(baseUrl, {
                messages: [{ role: 'user', content: 'new turn' }],
                conversation_id: conv.id,
            });
            assert.equal(result.status, 200);
        });

        // The refresh is fire-and-forget: poll briefly until it settles.
        let updated = persistence.getConversation(dirs, conv.id);
        const deadline = Date.now() + 5000;
        while (updated.summary !== 'Fresh rolling summary.' && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 25));
            updated = persistence.getConversation(dirs, conv.id);
        }
        assert.equal(updated.summary, 'Fresh rolling summary.', 'the rolling summary is refreshed after the turn');
        // 28 stored messages after the turn; the recent window end is 28 - 10.
        assert.equal(updated.summary_message_count, 18);
    } finally {
        tmp.cleanup();
    }
});

test('streaming conversation generation receives the stored summary and a budgeted prompt with the newest turn intact', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'alice', { name: 'C' });
        const conv = persistence.createConversation(dirs, 'alice', char.id, 'Test');
        const participant = conv.participants.find(p => p.role === 'character');
        // 40 oversized stored messages (~505 estimated tokens each); the first
        // 30 are covered by the rolling summary, so even the recent raw window
        // alone exceeds the 768-token deployment context.
        for (let i = 0; i < 40; i++) {
            const isUser = i % 2 === 0;
            persistence.appendMessage(dirs, conv.id, participant.id, `x${'x'.repeat(2000)}-${i}`, isUser ? 'user' : 'character');
        }
        persistence.updateConversation(dirs, conv.id, {
            summary: 'They met at the market and agreed to trade.',
            summary_message_count: 30,
        });
        const smallContextConfig = {
            ...configuredConfig,
            model: { ...configuredConfig.model, maxContextTokens: 768 },
        };
        const mock = mockStreamProvider([sseDelta('hi'), 'data: [DONE]\n\n']);
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withChatServer({
            loadConfig: async () => smallContextConfig,
            createProvider: () => mock.provider,
            runMemoryExtraction: async () => [],
        }, user, async baseUrl => {
            const result = await postChatStream(baseUrl, {
                messages: [{ role: 'user', content: 'new turn' }],
                stream: true,
                conversation_id: conv.id,
            });
            assert.equal(result.status, 200);
            assert.deepEqual(
                result.records.filter(r => r.type === 'delta'),
                [{ type: 'delta', text: 'hi' }],
                'the streamed reply is relayed to the client',
            );
            assert.ok(result.records.some(r => r.type === 'done' && r.conversation_id === conv.id));
        });

        assert.equal(mock.calls.length, 1, 'the stream provider is called exactly once');
        const prompt = mock.calls[0].messages;
        const system = prompt[0].content;
        assert.equal(prompt[0].role, 'system', 'the system prompt is never trimmed');
        assert.ok(system.includes('[Conversation Summary]'), 'summary section start delimiter');
        assert.ok(system.includes('They met at the market and agreed to trade.'), 'stored summary is injected');
        assert.ok(system.includes('[/Conversation Summary]'), 'summary section end delimiter');
        assert.equal(prompt[prompt.length - 1].content, 'new turn', 'the newest user turn is never trimmed');
        assert.ok(
            estimatePromptTokens(prompt) + DEFAULT_GENERATION_RESERVE_TOKENS <= 768,
            'streamed prompt plus generation reserve fits the configured context',
        );
        // The 10 oversized recent-window messages would far exceed the budget,
        // so only [system, newest turn] can remain — proving the budget ran on
        // the streamed prompt.
        assert.equal(prompt.length, 2, 'oversized history is trimmed away before streaming');
    } finally {
        tmp.cleanup();
    }
});

test('POST /chat keeps the unsummarized backlog in the prompt when the rolling summary is behind', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'alice', { name: 'C' });
        const conv = persistence.createConversation(dirs, 'alice', char.id, 'Test');
        const participant = conv.participants.find(p => p.role === 'character');
        // 40 stored messages; the summary only covers the first 10, leaving a
        // 20-message unsummarized backlog ahead of the recent raw window.
        for (let i = 0; i < 40; i++) {
            const isUser = i % 2 === 0;
            persistence.appendMessage(dirs, conv.id, participant.id, isUser ? `u${i}` : `c${i}`, isUser ? 'user' : 'character');
        }
        persistence.updateConversation(dirs, conv.id, {
            summary: 'They met at the market and agreed to trade.',
            summary_message_count: 10,
        });
        const mock = mockProvider(() => completion);
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withChatServer({
            loadConfig: async () => configuredConfig,
            createProvider: () => mock.provider,
            runMemoryExtraction: async () => [],
        }, user, async baseUrl => {
            const result = await postChat(baseUrl, {
                messages: [{ role: 'user', content: 'new turn' }],
                conversation_id: conv.id,
            });
            assert.equal(result.status, 200);
        });

        const prompt = mock.calls[0];
        assert.ok(prompt[0].content.includes('[Conversation Summary]'), 'summary section present');
        // The window starts at the covered count (10), not the recent-window
        // start (30): every unsummarized message plus the new turn reaches the
        // model, and all of them fit the default 4096-token budget.
        assert.equal(prompt.length, 1 + 30 + 1);
        assert.equal(prompt[1].content, 'u10', 'unsummarized backlog is not skipped');
        assert.equal(prompt[1 + 29].content, 'c39');
        assert.equal(prompt[prompt.length - 1].content, 'new turn');
        // The fire-and-forget refresh (after the user turn and the assistant
        // reply are stored: 42 total) is now caught up through the recent
        // window; let it settle before cleanup.
        let updated = persistence.getConversation(dirs, conv.id);
        const deadline = Date.now() + 5000;
        while (updated.summary_message_count !== 32 && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 25));
            updated = persistence.getConversation(dirs, conv.id);
        }
        assert.equal(updated.summary_message_count, 32, 'the refresh advances through the unsummarized backlog');
    } finally {
        tmp.cleanup();
    }
});

test('POST /chat budgets a character prompt against its server-controlled max_tokens', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'alice', { name: 'C', max_tokens: 8192 });
        const conv = persistence.createConversation(dirs, 'alice', char.id, 'Test');
        const participant = conv.participants.find(p => p.role === 'character');
        // 16 oversized history messages (~1005 estimated tokens each). With
        // the default 512-token reserve against a 10240-token context, about
        // nine of them would survive; the character's 8192-token generation
        // reserve must dominate instead.
        for (let i = 0; i < 16; i++) {
            const isUser = i % 2 === 0;
            persistence.appendMessage(dirs, conv.id, participant.id, `x${'x'.repeat(4000)}-${i}`, isUser ? 'user' : 'character');
        }
        const bigContextConfig = {
            ...configuredConfig,
            model: { ...configuredConfig.model, maxContextTokens: 10240 },
        };
        const mock = mockProvider(() => completion);
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withChatServer({
            loadConfig: async () => bigContextConfig,
            createProvider: () => mock.provider,
            runMemoryExtraction: async () => [],
        }, user, async baseUrl => {
            const result = await postChat(baseUrl, {
                messages: [{ role: 'user', content: 'new turn' }],
                conversation_id: conv.id,
            });
            assert.equal(result.status, 200);
        });

        const prompt = mock.calls[0];
        assert.ok(
            estimatePromptTokens(prompt) + char.max_tokens <= 10240,
            'prompt plus the character max_tokens reserve must fit the configured context',
        );
        assert.equal(prompt[0].role, 'system', 'the system prompt is never trimmed');
        assert.equal(prompt[prompt.length - 1].content, 'new turn', 'the newest user turn is never trimmed');
        // Only [system, one history message, new turn] fits the 10240 - 8192
        // limit — proving the larger generation reserve was used (the default
        // reserve would have kept about nine oversized messages).
        assert.equal(prompt.length, 3, 'the character max_tokens reserve trimmed the older history');
    } finally {
        tmp.cleanup();
    }
});

test('streaming conversation generation budgets against the character max_tokens identically', async () => {
    const tmp = makeTempDirs();
    try {
        const dirs = { root: tmp.root };
        persistence.ensureOpenParlorDirs(dirs);
        const char = persistence.createCharacter(dirs, 'alice', { name: 'C', max_tokens: 8192 });
        const conv = persistence.createConversation(dirs, 'alice', char.id, 'Test');
        const participant = conv.participants.find(p => p.role === 'character');
        for (let i = 0; i < 16; i++) {
            const isUser = i % 2 === 0;
            persistence.appendMessage(dirs, conv.id, participant.id, `x${'x'.repeat(4000)}-${i}`, isUser ? 'user' : 'character');
        }
        const bigContextConfig = {
            ...configuredConfig,
            model: { ...configuredConfig.model, maxContextTokens: 10240 },
        };
        const mock = mockStreamProvider([sseDelta('hi'), 'data: [DONE]\n\n']);
        const user = { profile: { handle: 'alice' }, directories: dirs };

        await withChatServer({
            loadConfig: async () => bigContextConfig,
            createProvider: () => mock.provider,
            runMemoryExtraction: async () => [],
        }, user, async baseUrl => {
            const result = await postChatStream(baseUrl, {
                messages: [{ role: 'user', content: 'new turn' }],
                stream: true,
                conversation_id: conv.id,
            });
            assert.equal(result.status, 200);
            assert.deepEqual(
                result.records.filter(r => r.type === 'delta'),
                [{ type: 'delta', text: 'hi' }],
                'the streamed reply is relayed to the client',
            );
            assert.ok(result.records.some(r => r.type === 'done' && r.conversation_id === conv.id));
        });

        assert.equal(mock.calls.length, 1, 'the stream provider is called exactly once');
        const prompt = mock.calls[0].messages;
        assert.ok(
            estimatePromptTokens(prompt) + char.max_tokens <= 10240,
            'streamed prompt plus the character max_tokens reserve fits the configured context',
        );
        assert.equal(prompt[0].role, 'system', 'the system prompt is never trimmed');
        assert.equal(prompt[prompt.length - 1].content, 'new turn', 'the newest user turn is never trimmed');
        assert.equal(prompt.length, 3, 'the character max_tokens reserve trimmed the older history');
    } finally {
        tmp.cleanup();
    }
});
