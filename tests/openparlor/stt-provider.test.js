import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSttProvider, SttProviderError } from '../../src/openparlor/stt-provider.js';

function makeConfig(overrides = {}) {
    return {
        provider: 'faster-whisper',
        pythonExecutable: '/usr/bin/python3',
        runnerPath: '/path/to/faster-whisper-runner.py',
        modelPath: '/path/to/model',
        modelCacheDir: '/path/to/model-cache',
        maxAudioBytes: 1024,
        timeoutMs: 5000,
        ...overrides,
    };
}

function makeMockSpawn(behavior) {
    const calls = [];
    const fn = (cmd, args, opts) => {
        calls.push({ cmd, args, opts });
        return behavior(cmd, args, opts);
    };
    fn.calls = calls;
    return fn;
}

function makeChildProcess({ stdout = '', stderr = '', exitCode = 0, error = null } = {}) {
    const child = new EventEmitter();
    child.stdin = { write: () => {}, end: () => {} };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};

    if (error) {
        process.nextTick(() => child.emit('error', error));
    } else {
        process.nextTick(() => {
            if (stdout) child.stdout.emit('data', Buffer.from(stdout));
            if (stderr) child.stderr.emit('data', Buffer.from(stderr));
            child.emit('close', exitCode);
        });
    }

    return child;
}

describe('createSttProvider', () => {
    describe('configuration validation', () => {
        test('throws on missing config', () => {
            assert.throws(() => createSttProvider(null), SttProviderError);
            assert.throws(() => createSttProvider(undefined), SttProviderError);
        });

        test('throws on unsupported provider', () => {
            assert.throws(
                () => createSttProvider({ ...makeConfig(), provider: 'other' }),
                (err) => err instanceof SttProviderError && err.code === 'INVALID_CONFIG',
            );
        });

        test('throws on missing pythonExecutable', () => {
            assert.throws(
                () => createSttProvider({ ...makeConfig(), pythonExecutable: '' }),
                (err) => err instanceof SttProviderError && err.code === 'INVALID_CONFIG',
            );
        });

        test('throws on missing runnerPath', () => {
            assert.throws(
                () => createSttProvider({ ...makeConfig(), runnerPath: '' }),
                (err) => err instanceof SttProviderError && err.code === 'INVALID_CONFIG',
            );
        });

        test('throws on missing modelPath', () => {
            assert.throws(
                () => createSttProvider({ ...makeConfig(), modelPath: '' }),
                (err) => err instanceof SttProviderError && err.code === 'INVALID_CONFIG',
            );
        });

        test('throws on invalid maxAudioBytes', () => {
            assert.throws(
                () => createSttProvider({ ...makeConfig(), maxAudioBytes: 0 }),
                (err) => err instanceof SttProviderError && err.code === 'INVALID_CONFIG',
            );
        });

        test('throws on invalid timeoutMs', () => {
            assert.throws(
                () => createSttProvider({ ...makeConfig(), timeoutMs: -1 }),
                (err) => err instanceof SttProviderError && err.code === 'INVALID_CONFIG',
            );
        });
    });

    describe('transcribe', () => {
        test('returns transcript text on success', async () => {
            const spawn = makeMockSpawn(() =>
                makeChildProcess({ stdout: JSON.stringify({ text: 'hello world', language: 'en' }) }),
            );
            const provider = createSttProvider(makeConfig(), { spawn });
            const result = await provider.transcribe(Buffer.from('fake-audio'));
            assert.strictEqual(result.text, 'hello world');
            assert.strictEqual(result.language, 'en');
        });

        test('returns transcript without language when not detected', async () => {
            const spawn = makeMockSpawn(() =>
                makeChildProcess({ stdout: JSON.stringify({ text: 'just text' }) }),
            );
            const provider = createSttProvider(makeConfig(), { spawn });
            const result = await provider.transcribe(Buffer.from('fake-audio'));
            assert.strictEqual(result.text, 'just text');
            assert.strictEqual(result.language, undefined);
        });

        test('uses argument-array spawn without shell', async () => {
            const spawn = makeMockSpawn(() =>
                makeChildProcess({ stdout: JSON.stringify({ text: 'ok' }) }),
            );
            const provider = createSttProvider(makeConfig(), { spawn });
            await provider.transcribe(Buffer.from('fake-audio'));

            assert.strictEqual(spawn.calls.length, 1);
            const call = spawn.calls[0];
            assert.strictEqual(call.cmd, '/usr/bin/python3');
            assert.ok(Array.isArray(call.args));
            assert.ok(call.args.length >= 1);
            assert.ok(!call.opts || call.opts.shell !== true);
        });

        test('rejects non-buffer audio', async () => {
            const spawn = makeMockSpawn(() => makeChildProcess());
            const provider = createSttProvider(makeConfig(), { spawn });
            await assert.rejects(
                provider.transcribe('not a buffer'),
                (err) => err instanceof SttProviderError && err.code === 'INVALID_AUDIO',
            );
        });

        test('rejects empty audio', async () => {
            const spawn = makeMockSpawn(() => makeChildProcess());
            const provider = createSttProvider(makeConfig(), { spawn });
            await assert.rejects(
                provider.transcribe(Buffer.alloc(0)),
                (err) => err instanceof SttProviderError && err.code === 'INVALID_AUDIO',
            );
        });

        test('rejects oversized audio', async () => {
            const spawn = makeMockSpawn(() => makeChildProcess());
            const provider = createSttProvider(makeConfig({ maxAudioBytes: 10 }), { spawn });
            await assert.rejects(
                provider.transcribe(Buffer.alloc(11)),
                (err) => err instanceof SttProviderError && err.code === 'INVALID_AUDIO',
            );
        });

        test('rejects invalid language option', async () => {
            const spawn = makeMockSpawn(() => makeChildProcess());
            const provider = createSttProvider(makeConfig(), { spawn });
            await assert.rejects(
                provider.transcribe(Buffer.from('audio'), { language: 'xx-invalid' }),
                (err) => err instanceof SttProviderError && err.code === 'INVALID_OPTIONS',
            );
        });

        test('rejects invalid task option', async () => {
            const spawn = makeMockSpawn(() => makeChildProcess());
            const provider = createSttProvider(makeConfig(), { spawn });
            await assert.rejects(
                provider.transcribe(Buffer.from('audio'), { task: 'invalid' }),
                (err) => err instanceof SttProviderError && err.code === 'INVALID_OPTIONS',
            );
        });

        test('rejects non-object options', async () => {
            const spawn = makeMockSpawn(() => makeChildProcess());
            const provider = createSttProvider(makeConfig(), { spawn });
            await assert.rejects(
                provider.transcribe(Buffer.from('audio'), 'string-opts'),
                (err) => err instanceof SttProviderError && err.code === 'INVALID_OPTIONS',
            );
        });

        test('maps worker non-zero exit to WORKER_ERROR', async () => {
            const spawn = makeMockSpawn(() =>
                makeChildProcess({ exitCode: 1, stderr: 'some error' }),
            );
            const provider = createSttProvider(makeConfig(), { spawn });
            await assert.rejects(
                provider.transcribe(Buffer.from('audio')),
                (err) => err instanceof SttProviderError && err.code === 'WORKER_ERROR',
            );
        });

        test('maps malformed JSON output to WORKER_ERROR', async () => {
            const spawn = makeMockSpawn(() =>
                makeChildProcess({ stdout: 'not json' }),
            );
            const provider = createSttProvider(makeConfig(), { spawn });
            await assert.rejects(
                provider.transcribe(Buffer.from('audio')),
                (err) => err instanceof SttProviderError && err.code === 'WORKER_ERROR',
            );
        });

        test('maps missing text field to WORKER_ERROR', async () => {
            const spawn = makeMockSpawn(() =>
                makeChildProcess({ stdout: JSON.stringify({ foo: 'bar' }) }),
            );
            const provider = createSttProvider(makeConfig(), { spawn });
            await assert.rejects(
                provider.transcribe(Buffer.from('audio')),
                (err) => err instanceof SttProviderError && err.code === 'WORKER_ERROR',
            );
        });

        test('maps ENOENT to EXECUTABLE_NOT_FOUND', async () => {
            const spawn = makeMockSpawn(() =>
                makeChildProcess({ error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) }),
            );
            const provider = createSttProvider(makeConfig(), { spawn });
            await assert.rejects(
                provider.transcribe(Buffer.from('audio')),
                (err) => err instanceof SttProviderError && err.code === 'EXECUTABLE_NOT_FOUND',
            );
        });

        test('maps timeout to TIMEOUT', async () => {
            const child = new EventEmitter();
            child.stdin = { write: () => {}, end: () => {} };
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            child.kill = () => {};

            const spawn = makeMockSpawn(() => child);
            const provider = createSttProvider(makeConfig({ timeoutMs: 50 }), { spawn });
            await assert.rejects(
                provider.transcribe(Buffer.from('audio')),
                (err) => err instanceof SttProviderError && err.code === 'TIMEOUT',
            );
        });

        test('does not expose paths or config in error messages', async () => {
            const spawn = makeMockSpawn(() =>
                makeChildProcess({ exitCode: 1, stderr: 'secret /path/to/model' }),
            );
            const provider = createSttProvider(makeConfig(), { spawn });
            try {
                await provider.transcribe(Buffer.from('audio'));
                assert.fail('should have thrown');
            } catch (err) {
                assert.ok(err instanceof SttProviderError);
                assert.ok(!err.message.includes('/path/to/model'));
                assert.ok(!err.message.includes('secret'));
            }
        });
    });

    describe('health', () => {
        test('returns ok on success', async () => {
            const spawn = makeMockSpawn(() =>
                makeChildProcess({ stdout: JSON.stringify({ status: 'ok' }) }),
            );
            const provider = createSttProvider(makeConfig(), { spawn });
            const result = await provider.health();
            assert.deepStrictEqual(result, { status: 'ok' });
        });

        test('maps non-zero exit to WORKER_ERROR', async () => {
            const spawn = makeMockSpawn(() =>
                makeChildProcess({ exitCode: 1 }),
            );
            const provider = createSttProvider(makeConfig(), { spawn });
            await assert.rejects(
                provider.health(),
                (err) => err instanceof SttProviderError && err.code === 'WORKER_ERROR',
            );
        });

        test('maps ENOENT to EXECUTABLE_NOT_FOUND', async () => {
            const spawn = makeMockSpawn(() =>
                makeChildProcess({ error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) }),
            );
            const provider = createSttProvider(makeConfig(), { spawn });
            await assert.rejects(
                provider.health(),
                (err) => err instanceof SttProviderError && err.code === 'EXECUTABLE_NOT_FOUND',
            );
        });

        test('passes --health flag in args', async () => {
            const spawn = makeMockSpawn(() =>
                makeChildProcess({ stdout: JSON.stringify({ status: 'ok' }) }),
            );
            const provider = createSttProvider(makeConfig(), { spawn });
            await provider.health();
            const call = spawn.calls[0];
            assert.ok(call.args.includes('--health'));
        });
    });
});
