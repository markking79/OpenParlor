import assert from 'node:assert/strict';
import test from 'node:test';
import { createModelProvider, ModelProviderError } from '../../src/openparlor/model-provider.js';

const config = { provider: 'openai-compatible', baseUrl: 'https://provider.example.invalid/v1///', model: 'test-model' };

function mockFetch(response) {
    const calls = [];
    return { calls, fetch: async (...args) => { calls.push(args); return typeof response === 'function' ? response(...args) : response; } };
}

function json(value, status = 200) {
    return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

test('factory rejects absent and unsupported providers', () => {
    assert.throws(() => createModelProvider({}), ModelProviderError);
    assert.throws(() => createModelProvider({ provider: 'other' }), /Unsupported/);
});

test('listModels normalizes trailing slashes and omits Authorization without a key', async () => {
    const mock = mockFetch(json({ data: [{ id: 'one' }] }));
    const provider = createModelProvider(config, { fetch: mock.fetch });
    assert.deepEqual(await provider.listModels(), [{ id: 'one' }]);
    assert.equal(mock.calls[0][0], 'https://provider.example.invalid/v1/models');
    assert.equal(mock.calls[0][1].headers.Authorization, undefined);
    assert.deepEqual(provider.getInfo(), { provider: 'openai-compatible', baseUrl: 'https://provider.example.invalid/v1', model: 'test-model' });
});

test('uses an optional API key and constructs non-streaming chat requests', async () => {
    const mock = mockFetch(json({ choices: [{ message: { content: 'ok' } }] }));
    const provider = createModelProvider({ ...config, apiKey: 'secret-value' }, { fetch: mock.fetch });
    await provider.chatCompletion([{ role: 'user', content: 'hello' }]);
    const [url, request] = mock.calls[0];
    assert.equal(url, 'https://provider.example.invalid/v1/chat/completions');
    assert.equal(request.headers.Authorization, 'Bearer secret-value');
    assert.deepEqual(JSON.parse(request.body), { model: 'test-model', messages: [{ role: 'user', content: 'hello' }], stream: false });
});

test('constructs streaming requests and forwards AbortSignal', async () => {
    const controller = new AbortController();
    const mock = mockFetch(new Response('data: done\n\n'));
    const provider = createModelProvider(config, { fetch: mock.fetch });
    const body = await provider.streamChatCompletion([], { signal: controller.signal });
    assert.ok(body);
    assert.equal(mock.calls[0][1].signal, controller.signal);
    assert.equal(JSON.parse(mock.calls[0][1].body).stream, true);
});

test('returns controlled errors for network, HTTP, invalid JSON, and malformed responses', async () => {
    const network = createModelProvider(config, { fetch: async () => { throw new Error('socket failure'); } });
    await assert.rejects(network.listModels(), /Network failure/);
    const http = createModelProvider(config, { fetch: async () => new Response('upstream unavailable', { status: 503 }) });
    await assert.rejects(http.listModels(), error => error.status === 503 && /upstream unavailable/.test(error.message));
    const invalid = createModelProvider(config, { fetch: async () => new Response('not json') });
    await assert.rejects(invalid.listModels(), /Invalid JSON/);
    const malformedModels = createModelProvider(config, { fetch: async () => json({ data: [{}] }) });
    await assert.rejects(malformedModels.listModels(), /Malformed models/);
    const malformedChat = createModelProvider(config, { fetch: async () => json({}) });
    await assert.rejects(malformedChat.chatCompletion([]), /Malformed chat/);
});
