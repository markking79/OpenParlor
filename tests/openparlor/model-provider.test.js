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
    assert.deepEqual(JSON.parse(request.body), {
        model: 'test-model',
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
        chat_template_kwargs: { enable_thinking: false },
    });
});

// The thinking control is what keeps a reasoning model from spending tens of
// seconds on `reasoning_content` that OpenParlor never renders.
test('suppresses the thinking phase by default and honors an explicit opt-out', async () => {
    const on = mockFetch(json({ choices: [{ message: { content: 'ok' } }] }));
    await createModelProvider(config, { fetch: on.fetch }).chatCompletion([{ role: 'user', content: 'hi' }]);
    assert.deepEqual(JSON.parse(on.calls[0][1].body).chat_template_kwargs, { enable_thinking: false });

    const off = mockFetch(json({ choices: [{ message: { content: 'ok' } }] }));
    await createModelProvider({ ...config, disableThinking: false }, { fetch: off.fetch }).chatCompletion([{ role: 'user', content: 'hi' }]);
    assert.equal(JSON.parse(off.calls[0][1].body).chat_template_kwargs, undefined);
});

test('an explicit caller chat_template_kwargs wins over the provider default', async () => {
    const mock = mockFetch(json({ choices: [{ message: { content: 'ok' } }] }));
    const provider = createModelProvider(config, { fetch: mock.fetch });
    await provider.chatCompletion([{ role: 'user', content: 'hi' }], { chat_template_kwargs: { enable_thinking: true } });
    assert.deepEqual(JSON.parse(mock.calls[0][1].body).chat_template_kwargs, { enable_thinking: true });
});

test('retries once without the thinking control when the server rejects the body', async () => {
    const responses = [
        new Response('unknown field chat_template_kwargs', { status: 400 }),
        json({ choices: [{ message: { content: 'ok' } }] }),
    ];
    let seen = 0;
    const mock = mockFetch(() => responses[seen++]);
    const rejecting = { ...config, baseUrl: 'https://rejects-think.example.invalid/v1' };
    const provider = createModelProvider(rejecting, { fetch: mock.fetch });
    const body = await provider.chatCompletion([{ role: 'user', content: 'hi' }]);
    assert.equal(body.choices[0].message.content, 'ok');
    assert.equal(mock.calls.length, 2);
    assert.deepEqual(JSON.parse(mock.calls[0][1].body).chat_template_kwargs, { enable_thinking: false });
    assert.equal(JSON.parse(mock.calls[1][1].body).chat_template_kwargs, undefined);

    // The rejection is remembered for the server, so the next turn — and every
    // later provider instance built for it — goes straight to the plain body.
    const after = mockFetch(json({ choices: [{ message: { content: 'ok' } }] }));
    await createModelProvider(rejecting, { fetch: after.fetch }).chatCompletion([{ role: 'user', content: 'again' }]);
    assert.equal(after.calls.length, 1);
    assert.equal(JSON.parse(after.calls[0][1].body).chat_template_kwargs, undefined);
});

test('does not retry a body rejection that the thinking control did not cause', async () => {
    const statuses = [500, 503];
    for (const status of statuses) {
        const mock = mockFetch(new Response('upstream failure', { status }));
        const provider = createModelProvider({ ...config, baseUrl: `https://fails-${status}.example.invalid/v1` }, { fetch: mock.fetch });
        await assert.rejects(provider.chatCompletion([{ role: 'user', content: 'hi' }]), error => error.status === status);
        assert.equal(mock.calls.length, 1, `status ${status} must not be retried`);
    }
});

test('a persistent body rejection still surfaces the server error', async () => {
    const mock = mockFetch(new Response('bad request', { status: 400 }));
    const provider = createModelProvider({ ...config, baseUrl: 'https://always-bad.example.invalid/v1' }, { fetch: mock.fetch });
    await assert.rejects(provider.chatCompletion([{ role: 'user', content: 'hi' }]), error => error.status === 400 && /bad request/.test(error.message));
    assert.equal(mock.calls.length, 2);
});

test('the streaming path applies the same thinking control and fallback', async () => {
    const ok = mockFetch(new Response('data: [DONE]\n\n'));
    const streaming = createModelProvider({ ...config, baseUrl: 'https://stream-ok.example.invalid/v1' }, { fetch: ok.fetch });
    assert.ok(await streaming.streamChatCompletion([{ role: 'user', content: 'hi' }]));
    assert.deepEqual(JSON.parse(ok.calls[0][1].body).chat_template_kwargs, { enable_thinking: false });

    const rejecting = [
        new Response('unsupported', { status: 422 }),
        new Response('data: [DONE]\n\n'),
    ];
    let seen = 0;
    const retry = mockFetch(() => rejecting[seen++]);
    const provider = createModelProvider({ ...config, baseUrl: 'https://stream-bad.example.invalid/v1' }, { fetch: retry.fetch });
    assert.ok(await provider.streamChatCompletion([{ role: 'user', content: 'hi' }]));
    assert.equal(retry.calls.length, 2);
    assert.equal(JSON.parse(retry.calls[1][1].body).chat_template_kwargs, undefined);
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
