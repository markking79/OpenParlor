import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    formatRelativeTime,
    normalizeConversation,
    normalizeCharacter,
    createNdjsonParser,
    mapChatRole,
    validateCharacterForm,
    sanitizeCharacterInput,
    normalizeModelStatus,
    normalizeTtsVoices,
    normalizeAutoSpeakState,
    createPlaybackController,
    shouldAutoSpeak,
} from '../../public/openparlor/openparlor.js';

// ─── formatRelativeTime ─────────────────────────────────────────────────────

describe('formatRelativeTime', () => {
    test('returns empty string for falsy input', () => {
        assert.equal(formatRelativeTime(''), '');
        assert.equal(formatRelativeTime(null), '');
        assert.equal(formatRelativeTime(undefined), '');
    });

    test('returns empty string for invalid date', () => {
        assert.equal(formatRelativeTime('not-a-date'), '');
    });

    test('returns "just now" for very recent times', () => {
        const now = new Date();
        const fiveSecAgo = new Date(now.getTime() - 5000).toISOString();
        assert.equal(formatRelativeTime(fiveSecAgo), 'just now');
    });

    test('returns seconds ago', () => {
        const now = new Date();
        const thirtySecAgo = new Date(now.getTime() - 30000).toISOString();
        assert.equal(formatRelativeTime(thirtySecAgo), '30s ago');
    });

    test('returns minutes ago', () => {
        const now = new Date();
        const fiveMinAgo = new Date(now.getTime() - 5 * 60000).toISOString();
        assert.equal(formatRelativeTime(fiveMinAgo), '5m ago');
    });

    test('returns hours ago', () => {
        const now = new Date();
        const threeHrAgo = new Date(now.getTime() - 3 * 3600000).toISOString();
        assert.equal(formatRelativeTime(threeHrAgo), '3h ago');
    });

    test('returns days ago', () => {
        const now = new Date();
        const twoDayAgo = new Date(now.getTime() - 2 * 86400000).toISOString();
        assert.equal(formatRelativeTime(twoDayAgo), '2d ago');
    });

    test('returns locale date for old dates', () => {
        const old = new Date('2020-01-15T00:00:00Z').toISOString();
        const result = formatRelativeTime(old);
        assert.notEqual(result, '');
        assert.doesNotMatch(result, /ago$/);
    });
});

// ─── normalizeConversation ──────────────────────────────────────────────────

describe('normalizeConversation', () => {
    test('returns null for falsy input', () => {
        assert.equal(normalizeConversation(null), null);
        assert.equal(normalizeConversation(undefined), null);
        assert.equal(normalizeConversation(''), null);
    });

    test('returns null for non-object input', () => {
        assert.equal(normalizeConversation(42), null);
    });

    test('normalizes a valid conversation', () => {
        const raw = {
            id: 'abc-123',
            title: 'My Chat',
            character_id: 'char-1',
            updated_at: '2025-01-01T00:00:00Z',
        };
        assert.deepEqual(normalizeConversation(raw), {
            id: 'abc-123',
            title: 'My Chat',
            characterId: 'char-1',
            updatedAt: '2025-01-01T00:00:00Z',
        });
    });

    test('provides defaults for missing fields', () => {
        const result = normalizeConversation({});
        assert.equal(result.id, '');
        assert.equal(result.title, 'Untitled');
        assert.equal(result.characterId, '');
        assert.equal(result.updatedAt, '');
    });

    test('coerces non-string id to string', () => {
        const result = normalizeConversation({ id: 42 });
        assert.equal(result.id, '42');
    });
});

// ─── normalizeCharacter ─────────────────────────────────────────────────────

describe('normalizeCharacter', () => {
    test('returns null for falsy input', () => {
        assert.equal(normalizeCharacter(null), null);
        assert.equal(normalizeCharacter(undefined), null);
    });

    test('returns null for non-object input', () => {
        assert.equal(normalizeCharacter('hello'), null);
    });

    test('normalizes a valid character', () => {
        const raw = {
            id: 'c1',
            name: 'Emma',
            avatar_url: '/avatars/emma.png',
            tts_voice: 'af_heart',
        };
        assert.deepEqual(normalizeCharacter(raw), {
            id: 'c1',
            name: 'Emma',
            avatarUrl: '/avatars/emma.png',
            ttsVoice: 'af_heart',
        });
    });

    test('provides defaults for missing fields', () => {
        const result = normalizeCharacter({});
        assert.equal(result.id, '');
        assert.equal(result.name, 'Unknown');
        assert.equal(result.avatarUrl, '');
        assert.equal(result.ttsVoice, '');
    });
});

// ─── createNdjsonParser ─────────────────────────────────────────────────────

describe('createNdjsonParser', () => {
    test('parses complete JSON lines', () => {
        const parser = createNdjsonParser();
        parser.feed(Buffer.from('{"type":"delta","text":"hello"}\n'));
        parser.feed(Buffer.from('{"type":"done"}\n'));
        parser.flush();
        assert.equal(parser.records.length, 2);
        assert.deepEqual(parser.records[0], { type: 'delta', text: 'hello' });
        assert.deepEqual(parser.records[1], { type: 'done' });
    });

    test('handles split chunks', () => {
        const parser = createNdjsonParser();
        parser.feed(Buffer.from('{"type":"del'));
        parser.feed(Buffer.from('ta","text":"hi"}\n'));
        parser.flush();
        assert.equal(parser.records.length, 1);
        assert.equal(parser.records[0].text, 'hi');
    });

    test('skips malformed lines', () => {
        const parser = createNdjsonParser();
        parser.feed(Buffer.from('not json\n{"type":"done"}\n'));
        parser.flush();
        assert.equal(parser.records.length, 1);
        assert.equal(parser.records[0].type, 'done');
    });

    test('handles empty input', () => {
        const parser = createNdjsonParser();
        parser.feed(Buffer.from(''));
        parser.flush();
        assert.equal(parser.records.length, 0);
    });

    test('flush handles remaining buffer without newline', () => {
        const parser = createNdjsonParser();
        parser.feed(Buffer.from('{"type":"done"}'));
        parser.flush();
        assert.equal(parser.records.length, 1);
        assert.equal(parser.records[0].type, 'done');
    });
});

// ─── mapChatRole ─────────────────────────────────────────────────────────────

describe('mapChatRole', () => {
    test('maps character to assistant', () => {
        assert.equal(mapChatRole('character'), 'assistant');
    });

    test('leaves user unchanged', () => {
        assert.equal(mapChatRole('user'), 'user');
    });

    test('leaves system unchanged', () => {
        assert.equal(mapChatRole('system'), 'system');
    });

    test('leaves assistant unchanged', () => {
        assert.equal(mapChatRole('assistant'), 'assistant');
    });

    test('returns unknown roles unchanged', () => {
        assert.equal(mapChatRole('tool'), 'tool');
    });
});

// ─── validateCharacterForm ──────────────────────────────────────────────────

describe('validateCharacterForm', () => {
    test('returns invalid for null input', () => {
        const result = validateCharacterForm(null);
        assert.equal(result.valid, false);
        assert.ok(result.errors.length > 0);
    });

    test('returns invalid for non-object input', () => {
        const result = validateCharacterForm('hello');
        assert.equal(result.valid, false);
    });

    test('returns invalid when name is empty', () => {
        const result = validateCharacterForm({ name: '' });
        assert.equal(result.valid, false);
        assert.ok(result.errors.some(e => e.includes('required')));
    });

    test('returns invalid when name is whitespace only', () => {
        const result = validateCharacterForm({ name: '   ' });
        assert.equal(result.valid, false);
    });

    test('returns invalid when name exceeds 100 chars', () => {
        const result = validateCharacterForm({ name: 'a'.repeat(101) });
        assert.equal(result.valid, false);
        assert.ok(result.errors.some(e => e.includes('100')));
    });

    test('returns valid for a proper name', () => {
        const result = validateCharacterForm({ name: 'Emma' });
        assert.equal(result.valid, true);
        assert.equal(result.errors.length, 0);
        assert.equal(result.name, 'Emma');
    });

    test('trims name in result', () => {
        const result = validateCharacterForm({ name: '  Emma  ' });
        assert.equal(result.valid, true);
        assert.equal(result.name, 'Emma');
    });

    test('returns valid for name at exactly 100 chars', () => {
        const result = validateCharacterForm({ name: 'a'.repeat(100) });
        assert.equal(result.valid, true);
    });
});

// ─── sanitizeCharacterInput ─────────────────────────────────────────────────

describe('sanitizeCharacterInput', () => {
    test('returns empty strings for null input', () => {
        assert.deepEqual(sanitizeCharacterInput(null), { name: '', avatarUrl: '', ttsVoice: '' });
    });

    test('returns empty strings for non-object input', () => {
        assert.deepEqual(sanitizeCharacterInput(42), { name: '', avatarUrl: '', ttsVoice: '' });
    });

    test('trims and returns clean name', () => {
        const result = sanitizeCharacterInput({ name: '  Emma  ', avatar_url: '' });
        assert.equal(result.name, 'Emma');
    });

    test('strips control characters from name', () => {
        const result = sanitizeCharacterInput({ name: 'Em\x00ma\x1f', avatar_url: '' });
        assert.equal(result.name, 'Emma');
    });

    test('truncates name to 100 chars', () => {
        const result = sanitizeCharacterInput({ name: 'a'.repeat(200), avatar_url: '' });
        assert.equal(result.name.length, 100);
    });

    test('blocks file:// protocol in avatar_url', () => {
        const result = sanitizeCharacterInput({ name: 'Test', avatar_url: 'file:///etc/passwd' });
        assert.equal(result.avatarUrl, '');
    });

    test('blocks javascript: protocol in avatar_url', () => {
        const result = sanitizeCharacterInput({ name: 'Test', avatar_url: 'javascript:alert(1)' });
        assert.equal(result.avatarUrl, '');
    });

    test('blocks data: protocol in avatar_url', () => {
        const result = sanitizeCharacterInput({ name: 'Test', avatar_url: 'data:text/html,<script>' });
        assert.equal(result.avatarUrl, '');
    });

    test('blocks path traversal in avatar_url', () => {
        const result = sanitizeCharacterInput({ name: 'Test', avatar_url: '/avatars/../../etc/passwd' });
        assert.equal(result.avatarUrl, '');
    });

    test('allows safe relative avatar URL', () => {
        const result = sanitizeCharacterInput({ name: 'Test', avatar_url: '/avatars/emma.png' });
        assert.equal(result.avatarUrl, '/avatars/emma.png');
    });

    test('allows empty avatar_url', () => {
        const result = sanitizeCharacterInput({ name: 'Test', avatar_url: '' });
        assert.equal(result.avatarUrl, '');
    });

    test('handles missing avatar_url field', () => {
        const result = sanitizeCharacterInput({ name: 'Test' });
        assert.equal(result.avatarUrl, '');
    });

    test('passes through valid tts_voice', () => {
        const result = sanitizeCharacterInput({ name: 'Test', tts_voice: 'af_heart' });
        assert.equal(result.ttsVoice, 'af_heart');
    });

    test('defaults tts_voice to empty string when missing', () => {
        const result = sanitizeCharacterInput({ name: 'Test' });
        assert.equal(result.ttsVoice, '');
    });

    test('defaults tts_voice to empty string when not a string', () => {
        const result = sanitizeCharacterInput({ name: 'Test', tts_voice: 42 });
        assert.equal(result.ttsVoice, '');
    });
});

// ─── normalizeModelStatus ───────────────────────────────────────────────────

describe('normalizeModelStatus', () => {
    test('returns default for null input', () => {
        assert.deepEqual(normalizeModelStatus(null), {
            provider: '', model: '', endpointLabel: '', models: [], connected: false,
        });
    });

    test('returns default for non-object input', () => {
        assert.deepEqual(normalizeModelStatus('hello'), {
            provider: '', model: '', endpointLabel: '', models: [], connected: false,
        });
    });

    test('normalizes a valid status', () => {
        const raw = {
            provider: 'openai',
            model: 'gpt-4',
            endpointLabel: 'api.openai.com',
            models: ['gpt-4', 'gpt-3.5-turbo'],
            connected: true,
        };
        assert.deepEqual(normalizeModelStatus(raw), {
            provider: 'openai',
            model: 'gpt-4',
            endpointLabel: 'api.openai.com',
            models: ['gpt-4', 'gpt-3.5-turbo'],
            connected: true,
        });
    });

    test('filters non-string models', () => {
        const result = normalizeModelStatus({ models: ['valid', 42, null, 'also-valid'] });
        assert.deepEqual(result.models, ['valid', 'also-valid']);
    });

    test('coerces connected to boolean', () => {
        assert.equal(normalizeModelStatus({ connected: 'yes' }).connected, false);
        assert.equal(normalizeModelStatus({ connected: true }).connected, true);
    });

    test('handles missing fields with defaults', () => {
        const result = normalizeModelStatus({});
        assert.equal(result.provider, '');
        assert.equal(result.model, '');
        assert.equal(result.endpointLabel, '');
        assert.deepEqual(result.models, []);
        assert.equal(result.connected, false);
    });
});

// ─── normalizeTtsVoices ─────────────────────────────────────────────────────

describe('normalizeTtsVoices', () => {
    test('returns default for null input', () => {
        assert.deepEqual(normalizeTtsVoices(null), { voices: [], available: false });
    });

    test('returns default for non-object input', () => {
        assert.deepEqual(normalizeTtsVoices('hello'), { voices: [], available: false });
    });

    test('normalizes a valid response', () => {
        const raw = { voices: ['af_heart', 'am_adam'], available: true };
        assert.deepEqual(normalizeTtsVoices(raw), { voices: ['af_heart', 'am_adam'], available: true });
    });

    test('filters non-string voices', () => {
        const result = normalizeTtsVoices({ voices: ['valid', 42, null, 'also-valid'], available: true });
        assert.deepEqual(result.voices, ['valid', 'also-valid']);
    });

    test('coerces available to boolean', () => {
        assert.equal(normalizeTtsVoices({ voices: [], available: 'yes' }).available, false);
        assert.equal(normalizeTtsVoices({ voices: [], available: true }).available, true);
    });

    test('handles missing fields with defaults', () => {
        const result = normalizeTtsVoices({});
        assert.deepEqual(result.voices, []);
        assert.equal(result.available, false);
    });
});

// ─── createPlaybackController ───────────────────────────────────────────────

describe('createPlaybackController', () => {
    function makeMockAudio() {
        const audio = {
            src: '',
            played: false,
            paused: false,
            async play() { this.played = true; },
            pause() { this.paused = true; },
        };
        return audio;
    }

    function makeDeps({ fetchResponse } = {}) {
        const createdUrls = [];
        const revokedUrls = [];
        let lastAudio = null;

        const deps = {
            fetchFn: async (url, opts) => {
                return fetchResponse || {
                    ok: true,
                    blob: async () => new Blob(['fake-audio']),
                    json: async () => ({}),
                };
            },
            createObjectURL: (blob) => {
                const url = `blob:mock-${createdUrls.length + 1}`;
                createdUrls.push(url);
                return url;
            },
            revokeObjectURL: (url) => { revokedUrls.push(url); },
            audioFactory: (url) => {
                lastAudio = makeMockAudio();
                lastAudio.src = url;
                return lastAudio;
            },
        };

        return { deps, createdUrls, revokedUrls, getLastAudio: () => lastAudio };
    }

    test('initial state is not playing', () => {
        const { deps } = makeDeps();
        const controller = createPlaybackController(deps);
        assert.equal(controller.isPlaying, false);
    });

    test('play fetches the synthesize endpoint with correct body', async () => {
        let capturedUrl = '';
        let capturedOpts = null;
        const deps = {
            fetchFn: async (url, opts) => {
                capturedUrl = url;
                capturedOpts = opts;
                return { ok: true, blob: async () => new Blob(['audio']) };
            },
            createObjectURL: () => 'blob:test-1',
            revokeObjectURL: () => {},
            audioFactory: () => makeMockAudio(),
        };
        const controller = createPlaybackController(deps);
        await controller.play('hello world', 'af_heart');

        assert.equal(capturedUrl, '/api/openparlor/tts/synthesize');
        assert.equal(capturedOpts.method, 'POST');
        assert.deepEqual(JSON.parse(capturedOpts.body), { text: 'hello world', voice: 'af_heart' });
    });

    test('play sets isPlaying to true and returns the object URL', async () => {
        const { deps } = makeDeps();
        const controller = createPlaybackController(deps);
        const url = await controller.play('test', 'af_heart');
        assert.equal(controller.isPlaying, true);
        assert.equal(url, 'blob:mock-1');
    });

    test('play calls audio.play()', async () => {
        const { deps, getLastAudio } = makeDeps();
        const controller = createPlaybackController(deps);
        await controller.play('test', 'af_heart');
        assert.equal(getLastAudio().played, true);
    });

    test('stop pauses audio and revokes object URL', async () => {
        const { deps, revokedUrls, getLastAudio } = makeDeps();
        const controller = createPlaybackController(deps);
        await controller.play('test', 'af_heart');
        controller.stop();
        assert.equal(controller.isPlaying, false);
        assert.equal(getLastAudio().paused, true);
        assert.deepEqual(revokedUrls, ['blob:mock-1']);
    });

    test('stop is safe to call when not playing', () => {
        const { deps, revokedUrls } = makeDeps();
        const controller = createPlaybackController(deps);
        controller.stop();
        assert.equal(controller.isPlaying, false);
        assert.deepEqual(revokedUrls, []);
    });

    test('play stops previous playback before starting new one', async () => {
        const { deps, revokedUrls } = makeDeps();
        const controller = createPlaybackController(deps);
        await controller.play('first', 'af_heart');
        await controller.play('second', 'am_adam');
        assert.equal(controller.isPlaying, true);
        assert.deepEqual(revokedUrls, ['blob:mock-1']);
    });

    test('replay works the same as play', async () => {
        const { deps, revokedUrls } = makeDeps();
        const controller = createPlaybackController(deps);
        await controller.play('test', 'af_heart');
        const url = await controller.replay('test', 'af_heart');
        assert.equal(controller.isPlaying, true);
        assert.equal(url, 'blob:mock-2');
        assert.deepEqual(revokedUrls, ['blob:mock-1']);
    });

    test('play throws when fetch returns non-ok response', async () => {
        const deps = {
            fetchFn: async () => ({
                ok: false,
                status: 503,
                json: async () => ({ error: 'TTS is not available' }),
            }),
            createObjectURL: () => 'blob:should-not-reach',
            revokeObjectURL: () => {},
            audioFactory: () => makeMockAudio(),
        };
        const controller = createPlaybackController(deps);
        await assert.rejects(() => controller.play('test', 'af_heart'), /TTS is not available/);
        assert.equal(controller.isPlaying, false);
    });

    test('play throws when fetch returns non-ok with no JSON body', async () => {
        const deps = {
            fetchFn: async () => ({
                ok: false,
                status: 500,
                json: async () => { throw new Error('not json'); },
            }),
            createObjectURL: () => 'blob:should-not-reach',
            revokeObjectURL: () => {},
            audioFactory: () => makeMockAudio(),
        };
        const controller = createPlaybackController(deps);
        await assert.rejects(() => controller.play('test', 'af_heart'), /Synthesis failed/);
        assert.equal(controller.isPlaying, false);
    });

    test('only one message plays at a time (sequential plays)', async () => {
        const { deps, getLastAudio } = makeDeps();
        const controller = createPlaybackController(deps);
        await controller.play('msg1', 'af_heart');
        await controller.play('msg2', 'am_adam');
        assert.equal(controller.isPlaying, true);
        // The first audio should have been paused
        // We can verify by checking that only the latest is active
        assert.equal(getLastAudio().played, true);
    });

    test('superseded play does not create or start audio (race)', async () => {
        let resolveFirst;
        const firstFetchPromise = new Promise(r => { resolveFirst = r; });

        const createdUrls = [];
        const revokedUrls = [];
        const audios = [];

        const deps = {
            fetchFn: (url, opts) => {
                // First call hangs until we resolve it
                if (createdUrls.length === 0) {
                    return firstFetchPromise.then(() => ({
                        ok: true,
                        blob: async () => new Blob(['first-audio']),
                    }));
                }
                // Second call resolves immediately
                return Promise.resolve({
                    ok: true,
                    blob: async () => new Blob(['second-audio']),
                });
            },
            createObjectURL: (blob) => {
                const url = `blob:race-${createdUrls.length + 1}`;
                createdUrls.push(url);
                return url;
            },
            revokeObjectURL: (url) => { revokedUrls.push(url); },
            audioFactory: (url) => {
                const audio = {
                    src: url,
                    played: false,
                    paused: false,
                    async play() { this.played = true; },
                    pause() { this.paused = true; },
                };
                audios.push(audio);
                return audio;
            },
        };

        const controller = createPlaybackController(deps);

        // Start first play (will hang on fetch)
        const firstPlay = controller.play('first', 'af_heart');

        // Start second play while first is still awaiting
        const secondPlay = controller.play('second', 'am_adam');

        // Resolve the first fetch — it should now be superseded
        resolveFirst();

        const firstResult = await firstPlay;
        const secondResult = await secondPlay;

        // The superseded first play should return null (no audio created)
        assert.equal(firstResult, null);
        // The second play should succeed
        assert.equal(secondResult, 'blob:race-1');
        // Only one audio object should have been created
        assert.equal(audios.length, 1);
        assert.equal(audios[0].played, true);
        assert.equal(controller.isPlaying, true);
    });

    test('stop during pending play prevents audio creation', async () => {
        let resolveFetch;
        const fetchPromise = new Promise(r => { resolveFetch = r; });

        const createdUrls = [];
        const audios = [];

        const deps = {
            fetchFn: () => fetchPromise.then(() => ({
                ok: true,
                blob: async () => new Blob(['audio']),
            })),
            createObjectURL: (blob) => {
                const url = `blob:stop-${createdUrls.length + 1}`;
                createdUrls.push(url);
                return url;
            },
            revokeObjectURL: () => {},
            audioFactory: (url) => {
                const audio = {
                    src: url,
                    played: false,
                    paused: false,
                    async play() { this.played = true; },
                    pause() { this.paused = true; },
                };
                audios.push(audio);
                return audio;
            },
        };

        const controller = createPlaybackController(deps);

        // Start play (will hang on fetch)
        const playPromise = controller.play('test', 'af_heart');

        // Stop while fetch is in flight
        controller.stop();

        // Resolve the fetch — should be superseded
        resolveFetch();

        const result = await playPromise;
        assert.equal(result, null);
        assert.equal(audios.length, 0);
        assert.equal(controller.isPlaying, false);
    });
});

// ─── shouldAutoSpeak ────────────────────────────────────────────────────────

describe('shouldAutoSpeak', () => {
    const base = {
        sendConversationId: 'conv-1',
        currentConversationId: 'conv-1',
        sendEpoch: 0,
        selectionEpoch: 0,
        streamDone: true,
        hadStreamError: false,
        autoSpeakEnabled: true,
        hasContent: true,
    };

    test('returns true when all conditions are met', () => {
        assert.equal(shouldAutoSpeak(base), true);
    });

    test('returns false when conversation changed', () => {
        assert.equal(shouldAutoSpeak({ ...base, currentConversationId: 'conv-2' }), false);
    });

    test('returns false when selection epoch changed (user clicked another conversation before fetch resolved)', () => {
        assert.equal(shouldAutoSpeak({ ...base, selectionEpoch: 1 }), false);
    });

    test('returns false when stream did not complete with done', () => {
        assert.equal(shouldAutoSpeak({ ...base, streamDone: false }), false);
    });

    test('returns false when stream had an error', () => {
        assert.equal(shouldAutoSpeak({ ...base, hadStreamError: true }), false);
    });

    test('returns false when auto-speak is disabled', () => {
        assert.equal(shouldAutoSpeak({ ...base, autoSpeakEnabled: false }), false);
    });

    test('returns false when there is no content', () => {
        assert.equal(shouldAutoSpeak({ ...base, hasContent: false }), false);
    });

    test('returns false when send conversation id is empty', () => {
        assert.equal(shouldAutoSpeak({ ...base, sendConversationId: '', currentConversationId: '' }), false);
    });

    test('returns false when both epoch and conversation changed', () => {
        assert.equal(shouldAutoSpeak({ ...base, currentConversationId: 'conv-2', selectionEpoch: 3 }), false);
    });
});

// ─── normalizeAutoSpeakState ────────────────────────────────────────────────

describe('normalizeAutoSpeakState', () => {
    test('returns true for string "true"', () => {
        assert.equal(normalizeAutoSpeakState('true'), true);
    });

    test('returns true for boolean true', () => {
        assert.equal(normalizeAutoSpeakState(true), true);
    });

    test('returns false for string "false"', () => {
        assert.equal(normalizeAutoSpeakState('false'), false);
    });

    test('returns false for boolean false', () => {
        assert.equal(normalizeAutoSpeakState(false), false);
    });

    test('returns false for null', () => {
        assert.equal(normalizeAutoSpeakState(null), false);
    });

    test('returns false for undefined', () => {
        assert.equal(normalizeAutoSpeakState(undefined), false);
    });

    test('returns false for empty string', () => {
        assert.equal(normalizeAutoSpeakState(''), false);
    });

    test('returns false for arbitrary string', () => {
        assert.equal(normalizeAutoSpeakState('yes'), false);
    });

    test('returns false for number', () => {
        assert.equal(normalizeAutoSpeakState(1), false);
    });
});
