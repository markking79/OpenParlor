import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getOpenParlorConfigPath, loadOpenParlorConfig } from '../../src/openparlor/config.js';

function disabledConfig() {
    return {
        model: { provider: 'openai-compatible', baseUrl: '', model: '', maxContextTokens: 0, thinking: 'auto' },
        stt: { provider: '', baseUrl: '', pythonExecutable: '', runnerPath: '', modelPath: '', modelCacheDir: '', maxAudioBytes: 0, timeoutMs: 0, language: '' },
        tts: { provider: '', baseUrl: '', voice: '' },
    };
}

describe('OpenParlor configuration loading', () => {
    function makeDirs() {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-openparlor-config-'));
        return { tmpDir, directories: { root: tmpDir } };
    }

    function cleanup(tmpDir) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    function writeConfig(directories, value) {
        const configPath = getOpenParlorConfigPath(directories);
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, value);
    }

    describe('getOpenParlorConfigPath', () => {
        test('joins the user data root with the fixed configuration path', () => {
            assert.equal(getOpenParlorConfigPath({ root: '/data/alice' }), path.join('/data/alice', 'openparlor', 'config.json'));
        });

        test('throws when the user directories root is missing or not a non-empty string', () => {
            assert.throws(() => getOpenParlorConfigPath(undefined), TypeError);
            assert.throws(() => getOpenParlorConfigPath(null), TypeError);
            assert.throws(() => getOpenParlorConfigPath({}), TypeError);
            assert.throws(() => getOpenParlorConfigPath({ root: '' }), TypeError);
            assert.throws(() => getOpenParlorConfigPath({ root: 42 }), TypeError);
        });
    });

    describe('loadOpenParlorConfig', () => {
        test('returns the disabled shape when the configuration file is missing and creates no files', async () => {
            const { tmpDir, directories } = makeDirs();
            try {
                const result = await loadOpenParlorConfig(directories);
                assert.deepEqual(result, disabledConfig());
                assert.equal(fs.existsSync(path.join(tmpDir, 'openparlor')), false);
                assert.deepEqual(fs.readdirSync(tmpDir), []);
            } finally {
                cleanup(tmpDir);
            }
        });

        test('returns the disabled shape when the configuration path is unreadable', async () => {
            const { tmpDir, directories } = makeDirs();
            try {
                // A directory where the file should live makes the read fail (EISDIR).
                writeConfig(directories, 'placeholder');
                fs.rmSync(getOpenParlorConfigPath(directories));
                fs.mkdirSync(getOpenParlorConfigPath(directories));
                const result = await loadOpenParlorConfig(directories);
                assert.deepEqual(result, disabledConfig());
            } finally {
                cleanup(tmpDir);
            }
        });

        test('normalizes a valid configuration', async () => {
            const { tmpDir, directories } = makeDirs();
            try {
                writeConfig(directories, JSON.stringify({
                    model: { provider: 'openai-compatible', baseUrl: 'https://model.example.invalid/v1', model: 'llama3', maxContextTokens: 32768, thinking: 'auto' },
                    stt: { provider: 'faster-whisper', baseUrl: '', pythonExecutable: '/usr/bin/python3', runnerPath: '/srv/runner.py', modelPath: '/srv/model', modelCacheDir: '/srv/cache', maxAudioBytes: 1024, timeoutMs: 5000, language: 'en' },
                    tts: { provider: 'kokoro', baseUrl: 'https://tts.example.invalid/v1', voice: 'af_heart' },
                }));
                const result = await loadOpenParlorConfig(directories);
                assert.deepEqual(result, {
                    model: { provider: 'openai-compatible', baseUrl: 'https://model.example.invalid/v1', model: 'llama3', maxContextTokens: 32768, thinking: 'auto' },
                    stt: { provider: 'faster-whisper', baseUrl: '', pythonExecutable: '/usr/bin/python3', runnerPath: '/srv/runner.py', modelPath: '/srv/model', modelCacheDir: '/srv/cache', maxAudioBytes: 1024, timeoutMs: 5000, language: 'en' },
                    tts: { provider: 'kokoro', baseUrl: 'https://tts.example.invalid/v1', voice: 'af_heart' },
                });
            } finally {
                cleanup(tmpDir);
            }
        });

        test('returns the disabled shape when the configuration is not valid JSON', async () => {
            const { tmpDir, directories } = makeDirs();
            try {
                writeConfig(directories, '{ "model": { "provider":');
                assert.deepEqual(await loadOpenParlorConfig(directories), disabledConfig());
            } finally {
                cleanup(tmpDir);
            }
        });

        test('returns the disabled shape when the parsed value is not an object', async () => {
            const { tmpDir, directories } = makeDirs();
            try {
                for (const value of ['[1, 2, 3]', '"openparlor"', '42', 'null', '']) {
                    writeConfig(directories, value);
                    assert.deepEqual(await loadOpenParlorConfig(directories), disabledConfig());
                }
            } finally {
                cleanup(tmpDir);
            }
        });

        test('normalizes malformed fields and ignores unknown fields', async () => {
            const { tmpDir, directories } = makeDirs();
            try {
                writeConfig(directories, JSON.stringify({
                    model: {
                        provider: 42,
                        baseUrl: 'https://model.example.invalid/v1',
                        model: ['unexpected'],
                    },
                    stt: null,
                    tts: {
                        voice: 'af_heart',
                        unknownField: 'ignored',
                    },
                    unknownSection: { anything: true },
                }));
                const result = await loadOpenParlorConfig(directories);
                assert.deepEqual(result, {
                    model: { provider: 'openai-compatible', baseUrl: 'https://model.example.invalid/v1', model: '', maxContextTokens: 0, thinking: 'auto' },
                    stt: { provider: '', baseUrl: '', pythonExecutable: '', runnerPath: '', modelPath: '', modelCacheDir: '', maxAudioBytes: 0, timeoutMs: 0, language: '' },
                    tts: { provider: '', baseUrl: '', voice: 'af_heart' },
                });
            } finally {
                cleanup(tmpDir);
            }
        });

        test('normalizes model.thinking to a known policy', async () => {
            const { tmpDir, directories } = makeDirs();
            try {
                for (const thinking of [undefined, null, 0, 'sometimes', {}, [], 'AUTO']) {
                    writeConfig(directories, JSON.stringify({ model: { thinking } }));
                    assert.equal((await loadOpenParlorConfig(directories)).model.thinking, 'auto');
                }
                for (const thinking of ['auto', 'always', 'never']) {
                    writeConfig(directories, JSON.stringify({ model: { thinking } }));
                    assert.equal((await loadOpenParlorConfig(directories)).model.thinking, thinking);
                }
            } finally {
                cleanup(tmpDir);
            }
        });

        test('normalizes model.maxContextTokens to the unconfigured default when absent or malformed', async () => {
            const { tmpDir, directories } = makeDirs();
            try {
                for (const maxContextTokens of [undefined, null, 0, -1, '32768', {}]) {
                    writeConfig(directories, JSON.stringify({ model: { maxContextTokens } }));
                    const result = await loadOpenParlorConfig(directories);
                    assert.equal(result.model.maxContextTokens, 0);
                }
                writeConfig(directories, JSON.stringify({ model: { maxContextTokens: 131072 } }));
                assert.equal((await loadOpenParlorConfig(directories)).model.maxContextTokens, 131072);
            } finally {
                cleanup(tmpDir);
            }
        });

        test('rejects when the user directories argument is invalid', async () => {
            await assert.rejects(loadOpenParlorConfig(undefined), TypeError);
            await assert.rejects(loadOpenParlorConfig({}), TypeError);
        });
    });
});
