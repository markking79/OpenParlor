import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getOpenParlorConfigPath, loadOpenParlorConfig } from '../../src/openparlor/config';

describe('OpenParlor configuration loading', () => {
    let tmpDir;
    let directories;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-openparlor-config-'));
        directories = { root: tmpDir };
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeConfig(value) {
        const configPath = getOpenParlorConfigPath(directories);
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, value);
    }

    function disabledConfig() {
        return {
            model: { provider: 'openai-compatible', baseUrl: '', model: '' },
            stt: { provider: '', baseUrl: '', pythonExecutable: '', runnerPath: '', modelPath: '', modelCacheDir: '', maxAudioBytes: 0, timeoutMs: 0, language: '' },
            tts: { provider: '', baseUrl: '', voice: '' },
        };
    }

    describe('getOpenParlorConfigPath', () => {
        test('joins the user data root with the fixed configuration path', () => {
            expect(getOpenParlorConfigPath({ root: '/data/alice' })).toBe(path.join('/data/alice', 'openparlor', 'config.json'));
        });

        test('throws when the user directories root is missing or not a non-empty string', () => {
            expect(() => getOpenParlorConfigPath(undefined)).toThrow(TypeError);
            expect(() => getOpenParlorConfigPath(null)).toThrow(TypeError);
            expect(() => getOpenParlorConfigPath({})).toThrow(TypeError);
            expect(() => getOpenParlorConfigPath({ root: '' })).toThrow(TypeError);
            expect(() => getOpenParlorConfigPath({ root: 42 })).toThrow(TypeError);
        });
    });

    describe('loadOpenParlorConfig', () => {
        test('returns the disabled shape when the configuration file is missing and creates no files', async () => {
            const result = await loadOpenParlorConfig(directories);
            expect(result).toEqual(disabledConfig());
            expect(fs.existsSync(path.join(tmpDir, 'openparlor'))).toBe(false);
            expect(fs.readdirSync(tmpDir)).toEqual([]);
        });

        test('returns the disabled shape when the configuration path is unreadable', async () => {
            // A directory where the file should live makes the read fail (EISDIR).
            writeConfig('placeholder');
            fs.rmSync(getOpenParlorConfigPath(directories));
            fs.mkdirSync(getOpenParlorConfigPath(directories));
            const result = await loadOpenParlorConfig(directories);
            expect(result).toEqual(disabledConfig());
        });

        test('normalizes a valid configuration', async () => {
            writeConfig(JSON.stringify({
                model: { provider: 'openai-compatible', baseUrl: 'https://model.example.invalid/v1', model: 'llama3' },
                stt: { provider: 'faster-whisper', baseUrl: '', pythonExecutable: '/usr/bin/python3', runnerPath: '/srv/runner.py', modelPath: '/srv/model', modelCacheDir: '/srv/cache', maxAudioBytes: 1024, timeoutMs: 5000, language: 'en' },
                tts: { provider: 'kokoro', baseUrl: 'https://tts.example.invalid/v1', voice: 'af_heart' },
            }));
            const result = await loadOpenParlorConfig(directories);
            expect(result).toEqual({
                model: { provider: 'openai-compatible', baseUrl: 'https://model.example.invalid/v1', model: 'llama3' },
                stt: { provider: 'faster-whisper', baseUrl: '', pythonExecutable: '/usr/bin/python3', runnerPath: '/srv/runner.py', modelPath: '/srv/model', modelCacheDir: '/srv/cache', maxAudioBytes: 1024, timeoutMs: 5000, language: 'en' },
                tts: { provider: 'kokoro', baseUrl: 'https://tts.example.invalid/v1', voice: 'af_heart' },
            });
        });

        test('returns the disabled shape when the configuration is not valid JSON', async () => {
            writeConfig('{ "model": { "provider":');
            expect(await loadOpenParlorConfig(directories)).toEqual(disabledConfig());
        });

        test('returns the disabled shape when the parsed value is not an object', async () => {
            for (const value of ['[1, 2, 3]', '"openparlor"', '42', 'null', '']) {
                writeConfig(value);
                expect(await loadOpenParlorConfig(directories)).toEqual(disabledConfig());
            }
        });

        test('normalizes malformed fields and ignores unknown fields', async () => {
            writeConfig(JSON.stringify({
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
            expect(result).toEqual({
                model: { provider: 'openai-compatible', baseUrl: 'https://model.example.invalid/v1', model: '' },
                stt: { provider: '', baseUrl: '', pythonExecutable: '', runnerPath: '', modelPath: '', modelCacheDir: '', maxAudioBytes: 0, timeoutMs: 0, language: '' },
                tts: { provider: '', baseUrl: '', voice: 'af_heart' },
            });
        });

        test('rejects when the user directories argument is invalid', async () => {
            await expect(loadOpenParlorConfig(undefined)).rejects.toThrow(TypeError);
            await expect(loadOpenParlorConfig({})).rejects.toThrow(TypeError);
        });
    });
});
