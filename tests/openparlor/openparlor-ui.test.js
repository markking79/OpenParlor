import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    formatRelativeTime,
    normalizeConversation,
    normalizeCharacter,
    createNdjsonParser,
    createStreamMessageCollector,
    mapChatRole,
    validateCharacterForm,
    sanitizeCharacterInput,
    normalizeModelStatus,
    normalizeTtsVoices,
    normalizeAutoSpeakState,
    normalizeVoiceModeState,
    shouldAutoSendTranscription,
    createPlaybackController,
    shouldAutoSpeak,
    selectSupportedMime,
    createRecorderController,
    createTranscriptionController,
    createVoiceTurnTimer,
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
            archived: false,
        });
    });

    test('maps archived characters and defaults archived to false', () => {
        assert.equal(normalizeCharacter({ id: 'c2', name: 'Old', archived: true }).archived, true);
        assert.equal(normalizeCharacter({ id: 'c3', name: 'New' }).archived, false);
        assert.equal(normalizeCharacter({ id: 'c4', name: 'Weird', archived: 'true' }).archived, false);
    });

    test('provides defaults for missing fields', () => {
        const result = normalizeCharacter({});
        assert.equal(result.id, '');
        assert.equal(result.name, 'Unknown');
        assert.equal(result.avatarUrl, '');
        assert.equal(result.ttsVoice, '');
        assert.equal(result.archived, false);
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

    test('returns false when recording is active', () => {
        assert.equal(shouldAutoSpeak({ ...base, recordingActive: true }), false);
    });

    test('returns true when recording is not active', () => {
        assert.equal(shouldAutoSpeak({ ...base, recordingActive: false }), true);
    });

    test('defaults recordingActive to false when omitted', () => {
        assert.equal(shouldAutoSpeak(base), true);
    });

    test('returns false when recording is active even if all other conditions are met', () => {
        assert.equal(shouldAutoSpeak({ ...base, recordingActive: true }), false);
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

// ─── normalizeVoiceModeState ────────────────────────────────────────────────

describe('normalizeVoiceModeState', () => {
    test('returns true for string "true"', () => {
        assert.equal(normalizeVoiceModeState('true'), true);
    });

    test('returns true for boolean true', () => {
        assert.equal(normalizeVoiceModeState(true), true);
    });

    test('returns false for string "false"', () => {
        assert.equal(normalizeVoiceModeState('false'), false);
    });

    test('returns false for boolean false', () => {
        assert.equal(normalizeVoiceModeState(false), false);
    });

    test('returns false for null', () => {
        assert.equal(normalizeVoiceModeState(null), false);
    });

    test('returns false for undefined', () => {
        assert.equal(normalizeVoiceModeState(undefined), false);
    });

    test('returns false for empty string', () => {
        assert.equal(normalizeVoiceModeState(''), false);
    });

    test('returns false for arbitrary string', () => {
        assert.equal(normalizeVoiceModeState('yes'), false);
    });

    test('returns false for number', () => {
        assert.equal(normalizeVoiceModeState(1), false);
    });
});

// ─── shouldAutoSendTranscription ────────────────────────────────────────────

describe('shouldAutoSendTranscription', () => {
    test('returns true when voice mode is enabled and transcription succeeded', () => {
        assert.equal(shouldAutoSendTranscription({ voiceModeEnabled: true, transcriptionSucceeded: true }), true);
    });

    test('returns false when voice mode is disabled', () => {
        assert.equal(shouldAutoSendTranscription({ voiceModeEnabled: false, transcriptionSucceeded: true }), false);
    });

    test('returns false when transcription did not succeed', () => {
        assert.equal(shouldAutoSendTranscription({ voiceModeEnabled: true, transcriptionSucceeded: false }), false);
    });

    test('returns false when both are false', () => {
        assert.equal(shouldAutoSendTranscription({ voiceModeEnabled: false, transcriptionSucceeded: false }), false);
    });
});

// ─── selectSupportedMime ────────────────────────────────────────────────────

describe('selectSupportedMime', () => {
    test('returns first supported MIME from candidates', () => {
        const supported = new Set(['audio/webm', 'audio/mp4']);
        const result = selectSupportedMime(
            ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'],
            (m) => supported.has(m),
        );
        assert.equal(result, 'audio/webm');
    });

    test('returns empty string when no candidates are supported', () => {
        const result = selectSupportedMime(
            ['audio/webm;codecs=opus', 'audio/webm'],
            () => false,
        );
        assert.equal(result, '');
    });

    test('returns empty string for empty candidates array', () => {
        const result = selectSupportedMime([], () => true);
        assert.equal(result, '');
    });

    test('returns first candidate if it is supported', () => {
        const result = selectSupportedMime(
            ['audio/webm;codecs=opus', 'audio/webm'],
            (m) => m === 'audio/webm;codecs=opus',
        );
        assert.equal(result, 'audio/webm;codecs=opus');
    });
});

// ─── createRecorderController ───────────────────────────────────────────────

describe('createRecorderController', () => {
    function makeMockStream() {
        const tracks = [{ stop() { this._stopped = true; } }];
        return { getTracks: () => tracks, _tracks: tracks };
    }

    function makeMockMediaRecorder({ supportedTypes = ['audio/webm;codecs=opus', 'audio/webm'] } = {}) {
        const instances = [];
        class MockMediaRecorder {
            constructor(stream, options) {
                this.stream = stream;
                this.options = options || {};
                this.state = 'inactive';
                this.ondataavailable = null;
                this.onstop = null;
                instances.push(this);
            }
            static isTypeSupported(mime) {
                return supportedTypes.includes(mime);
            }
            start(timeslice) {
                this.state = 'recording';
                this._timeslice = timeslice;
            }
            stop() {
                if (this.state === 'recording') {
                    this.state = 'inactive';
                    if (this.onstop) this.onstop();
                }
            }
            emitData(chunk) {
                if (this.ondataavailable) {
                    this.ondataavailable({ data: chunk });
                }
            }
        }
        return { MockMediaRecorder, instances };
    }

    function makeDeps({ supportedTypes, getUserMediaError, maxDurationMs, maxSizeBytes } = {}) {
        const { MockMediaRecorder, instances } = makeMockMediaRecorder({ supportedTypes });
        const stream = makeMockStream();

        const deps = {
            getUserMedia: async () => {
                if (getUserMediaError) throw getUserMediaError;
                return stream;
            },
            MediaRecorderCtor: MockMediaRecorder,
            maxDurationMs: maxDurationMs || 60000,
            maxSizeBytes: maxSizeBytes || 5 * 1024 * 1024,
        };

        return { deps, instances, stream };
    }

    test('initial state is idle', () => {
        const { deps } = makeDeps();
        const controller = createRecorderController(deps);
        assert.equal(controller.state, 'idle');
        assert.equal(controller.blob, null);
        assert.equal(controller.error, null);
    });

    test('start transitions to recording state', async () => {
        const { deps, instances } = makeDeps();
        const controller = createRecorderController(deps);
        await controller.start();
        assert.equal(controller.state, 'recording');
        assert.equal(instances.length, 1);
        assert.equal(instances[0].state, 'recording');
    });

    test('start selects supported MIME type', async () => {
        const { deps, instances } = makeDeps({ supportedTypes: ['audio/webm'] });
        const controller = createRecorderController(deps);
        await controller.start();
        assert.equal(instances[0].options.mimeType, 'audio/webm');
    });

    test('start uses no mimeType option when no type is supported', async () => {
        const { deps, instances } = makeDeps({ supportedTypes: [] });
        const controller = createRecorderController(deps);
        await controller.start();
        assert.equal(instances[0].options.mimeType, undefined);
    });

    test('stop transitions to stopped and produces a blob', async () => {
        const { deps, instances } = makeDeps();
        const controller = createRecorderController(deps);
        await controller.start();

        // Simulate data chunks
        instances[0].emitData(new Blob(['chunk1']));
        instances[0].emitData(new Blob(['chunk2']));

        controller.stop();
        assert.equal(controller.state, 'stopped');
        assert.ok(controller.blob instanceof Blob);
        assert.equal(controller.blob.size, 12); // 'chunk1' + 'chunk2'
    });

    test('stop is safe to call when not recording', () => {
        const { deps } = makeDeps();
        const controller = createRecorderController(deps);
        controller.stop();
        assert.equal(controller.state, 'idle');
    });

    test('cancel transitions back to idle and discards blob', async () => {
        const { deps, instances } = makeDeps();
        const controller = createRecorderController(deps);
        await controller.start();

        instances[0].emitData(new Blob(['data']));

        controller.cancel();
        assert.equal(controller.state, 'idle');
        assert.equal(controller.blob, null);
    });

    test('cancel is safe to call when not recording', () => {
        const { deps } = makeDeps();
        const controller = createRecorderController(deps);
        controller.cancel();
        assert.equal(controller.state, 'idle');
    });

    test('permission denied sets error state', async () => {
        const err = new Error('Permission denied');
        err.name = 'NotAllowedError';
        const { deps } = makeDeps({ getUserMediaError: err });
        const controller = createRecorderController(deps);
        await controller.start();
        assert.equal(controller.state, 'error');
        assert.equal(controller.error, 'Permission denied');
    });

    test('microphone unavailable sets error state', async () => {
        const err = new Error('No device');
        err.name = 'NotFoundError';
        const { deps } = makeDeps({ getUserMediaError: err });
        const controller = createRecorderController(deps);
        await controller.start();
        assert.equal(controller.state, 'error');
        assert.equal(controller.error, 'Microphone unavailable');
    });

    test('MediaRecorder not supported sets error state', async () => {
        const { deps } = makeDeps();
        const controller = createRecorderController({ ...deps, MediaRecorderCtor: null });
        await controller.start();
        assert.equal(controller.state, 'error');
        assert.equal(controller.error, 'MediaRecorder not supported');
    });

    test('maximum duration stops recording and produces blob', async () => {
        const { deps, instances } = makeDeps({ maxDurationMs: 50 });
        const states = [];
        const controller = createRecorderController({ ...deps, onStateChange: (s) => states.push(s) });
        await controller.start();

        instances[0].emitData(new Blob(['audio-data']));

        // Wait for the duration timer to fire
        await new Promise(r => setTimeout(r, 150));

        assert.equal(controller.state, 'stopped');
        assert.ok(controller.blob instanceof Blob);
        assert.ok(states.includes('recording'));
        assert.ok(states.includes('stopped'));
    });

    test('maximum size stops recording and produces blob', async () => {
        const { deps, instances } = makeDeps({ maxSizeBytes: 10 });
        const controller = createRecorderController(deps);
        await controller.start();

        // Emit a chunk that exceeds the size limit
        instances[0].emitData(new Blob(['this-is-a-long-chunk-over-10-bytes']));

        assert.equal(controller.state, 'stopped');
        assert.ok(controller.blob instanceof Blob);
    });

    test('chunks within size limit are retained', async () => {
        const { deps, instances } = makeDeps({ maxSizeBytes: 100 });
        const controller = createRecorderController(deps);
        await controller.start();

        instances[0].emitData(new Blob(['small']));
        instances[0].emitData(new Blob(['data']));

        controller.stop();
        assert.equal(controller.blob.size, 9); // 'small' + 'data'
    });

    test('stream tracks are stopped on cleanup after stop', async () => {
        const { deps, stream } = makeDeps();
        const controller = createRecorderController(deps);
        await controller.start();
        controller.stop();
        assert.equal(stream._tracks[0]._stopped, true);
    });

    test('stream tracks are stopped on cleanup after cancel', async () => {
        const { deps, stream } = makeDeps();
        const controller = createRecorderController(deps);
        await controller.start();
        controller.cancel();
        assert.equal(stream._tracks[0]._stopped, true);
    });

    test('onStateChange callback is invoked on transitions', async () => {
        const { deps } = makeDeps();
        const states = [];
        const controller = createRecorderController({ ...deps, onStateChange: (s) => states.push(s) });
        await controller.start();
        controller.stop();
        assert.deepEqual(states, ['recording', 'stopped']);
    });

    test('start is idempotent while recording', async () => {
        const { deps, instances } = makeDeps();
        const controller = createRecorderController(deps);
        await controller.start();
        await controller.start(); // Should be a no-op
        assert.equal(instances.length, 1);
        assert.equal(controller.state, 'recording');
    });

    test('can start again after stopped', async () => {
        const { deps, instances } = makeDeps();
        const controller = createRecorderController(deps);
        await controller.start();
        controller.stop();
        assert.equal(controller.state, 'stopped');

        await controller.start();
        assert.equal(controller.state, 'recording');
        assert.equal(instances.length, 2);
    });

    test('can start again after error', async () => {
        const err = new Error('denied');
        err.name = 'NotAllowedError';
        const { deps } = makeDeps({ getUserMediaError: err });
        const controller = createRecorderController(deps);
        await controller.start();
        assert.equal(controller.state, 'error');

        // Now fix the error and try again
        const fixedDeps = makeDeps();
        const controller2 = createRecorderController(fixedDeps.deps);
        await controller2.start();
        assert.equal(controller2.state, 'recording');
    });
});

// ─── createVoiceTurnTimer ───────────────────────────────────────────────────

describe('createVoiceTurnTimer', () => {
    function makeClock() {
        let t = 0;
        return {
            now: () => t,
            advance: (ms) => { t += ms; },
        };
    }

    test('initial state is not active', () => {
        const timer = createVoiceTurnTimer({ now: () => 0 });
        assert.equal(timer.active, false);
    });

    test('start makes timer active', () => {
        const timer = createVoiceTurnTimer({ now: () => 0 });
        timer.start();
        assert.equal(timer.active, true);
    });

    test('cancel makes timer inactive and clears marks', () => {
        const clock = makeClock();
        const timer = createVoiceTurnTimer({ now: clock.now });
        timer.start();
        timer.markRecordingEnd();
        clock.advance(100);
        timer.markSttComplete();
        timer.cancel();
        assert.equal(timer.active, false);
        assert.equal(timer.report(), null);
    });

    test('marks are ignored when not active', () => {
        const clock = makeClock();
        const timer = createVoiceTurnTimer({ now: clock.now });
        timer.markRecordingEnd();
        timer.markSttComplete();
        assert.equal(timer.report(), null);
    });

    test('report returns null when not active', () => {
        const timer = createVoiceTurnTimer({ now: () => 0 });
        assert.equal(timer.report(), null);
    });

    test('report returns correct phase durations for a complete turn', () => {
        const clock = makeClock();
        const timer = createVoiceTurnTimer({ now: clock.now });
        timer.start();
        timer.markRecordingEnd();       // t=0
        clock.advance(200);
        timer.markSttComplete();       // t=200
        clock.advance(50);
        timer.markSendStart();         // t=250
        clock.advance(300);
        timer.markFirstToken();        // t=550
        clock.advance(1000);
        timer.markStreamComplete();    // t=1550
        clock.advance(400);
        timer.markTtsReady();          // t=1950

        const report = timer.report();
        assert.equal(report.recordingToStt, 200);
        assert.equal(report.sendToFirstToken, 300);
        assert.equal(report.firstTokenToComplete, 1000);
        assert.equal(report.completeToTts, 400);
        assert.equal(report.totalTurn, 1950);
    });

    test('report returns null for missing phases', () => {
        const clock = makeClock();
        const timer = createVoiceTurnTimer({ now: clock.now });
        timer.start();
        timer.markRecordingEnd();
        clock.advance(100);
        timer.markSttComplete();
        // No send, no tokens, no TTS

        const report = timer.report();
        assert.equal(report.recordingToStt, 100);
        assert.equal(report.sendToFirstToken, null);
        assert.equal(report.firstTokenToComplete, null);
        assert.equal(report.completeToTts, null);
        assert.equal(report.totalTurn, null);
    });

    test('markFirstToken is idempotent (only records first call)', () => {
        const clock = makeClock();
        const timer = createVoiceTurnTimer({ now: clock.now });
        timer.start();
        timer.markSendStart();         // t=0
        clock.advance(100);
        timer.markFirstToken();        // t=100
        clock.advance(200);
        timer.markFirstToken();        // t=300 (should be ignored)
        clock.advance(100);
        timer.markStreamComplete();    // t=400

        const report = timer.report();
        assert.equal(report.sendToFirstToken, 100);
        assert.equal(report.firstTokenToComplete, 300);
    });

    test('log calls injected logFn with rounded ms strings', () => {
        const clock = makeClock();
        const logged = [];
        const timer = createVoiceTurnTimer({ now: clock.now, logFn: (d) => logged.push(d) });
        timer.start();
        timer.markRecordingEnd();
        clock.advance(150);
        timer.markSttComplete();
        clock.advance(200);
        timer.markSendStart();
        clock.advance(350);
        timer.markFirstToken();
        clock.advance(500);
        timer.markStreamComplete();
        clock.advance(100);
        timer.markTtsReady();

        timer.log();
        assert.equal(logged.length, 1);
        assert.equal(logged[0].recordingToStt, '150ms');
        assert.equal(logged[0].sendToFirstToken, '350ms');
        assert.equal(logged[0].firstTokenToComplete, '500ms');
        assert.equal(logged[0].completeToTts, '100ms');
        assert.equal(logged[0].totalTurn, '1300ms');
    });

    test('log is a no-op when not active', () => {
        const logged = [];
        const timer = createVoiceTurnTimer({ now: () => 0, logFn: (d) => logged.push(d) });
        timer.log();
        assert.equal(logged.length, 0);
    });

    test('log shows n/a for missing phases', () => {
        const clock = makeClock();
        const logged = [];
        const timer = createVoiceTurnTimer({ now: clock.now, logFn: (d) => logged.push(d) });
        timer.start();
        timer.markRecordingEnd();
        clock.advance(100);
        timer.markSttComplete();

        timer.log();
        assert.equal(logged.length, 1);
        assert.equal(logged[0].recordingToStt, '100ms');
        assert.equal(logged[0].sendToFirstToken, 'n/a');
        assert.equal(logged[0].firstTokenToComplete, 'n/a');
        assert.equal(logged[0].completeToTts, 'n/a');
        assert.equal(logged[0].totalTurn, 'n/a');
    });

    test('start resets previous marks', () => {
        const clock = makeClock();
        const timer = createVoiceTurnTimer({ now: clock.now });
        timer.start();
        timer.markRecordingEnd();
        clock.advance(500);
        timer.markSttComplete();

        // Start a new turn
        timer.start();
        assert.equal(timer.active, true);
        const report = timer.report();
        assert.equal(report.recordingToStt, null);
        assert.equal(report.totalTurn, null);
    });

    test('cancel then start produces a fresh timer', () => {
        const clock = makeClock();
        const timer = createVoiceTurnTimer({ now: clock.now });
        timer.start();
        timer.markRecordingEnd();
        timer.cancel();

        timer.start();
        assert.equal(timer.active, true);
        const report = timer.report();
        assert.equal(report.recordingToStt, null);
    });
});

describe('createTranscriptionController', () => {
    test('posts exactly one audio Blob with CSRF and returns text without sending chat', async () => {
        let request;
        const controller = createTranscriptionController({
            getCsrfToken: async () => 'csrf-token',
            fetchFn: async (url, options) => {
                request = { url, options };
                return { ok: true, json: async () => ({ text: ' transcribed words ', language: 'en' }) };
            },
        });
        const text = await controller.transcribe(new Blob(['recording'], { type: 'audio/webm' }));
        assert.equal(text, 'transcribed words');
        assert.equal(controller.state, 'ready');
        assert.equal(request.url, '/api/openparlor/stt/transcribe');
        assert.equal(request.options.method, 'POST');
        assert.equal(request.options.headers['X-CSRF-Token'], 'csrf-token');
        assert.equal(request.options.body.getAll('audio').length, 1);
    });

    test('reports a safe error and permits retry after a failed transcription', async () => {
        let attempts = 0;
        const controller = createTranscriptionController({
            getCsrfToken: async () => 'csrf-token',
            fetchFn: async () => {
                attempts++;
                return attempts === 1
                    ? { ok: false, json: async () => ({ error: 'provider path /secret' }) }
                    : { ok: true, json: async () => ({ text: 'retry worked' }) };
            },
        });
        const blob = new Blob(['recording'], { type: 'audio/webm' });
        assert.equal(await controller.transcribe(blob), null);
        assert.equal(controller.state, 'error');
        assert.equal(controller.error, 'Transcription failed. Please try again.');
        assert.equal(await controller.transcribe(blob), 'retry worked');
        assert.equal(controller.state, 'ready');
    });
});

// ─── createStreamMessageCollector (QWEN-GROUP-001) ───────────────────────────

describe('createStreamMessageCollector', () => {
    test('first speaker_start determines the pending message identity', () => {
        const collector = createStreamMessageCollector();
        assert.equal(collector.getMessages().length, 1, 'a pending message exists before any record');
        collector.handleRecord({ type: 'speaker_start', character_id: 'char-monica', participant_id: 'part-monica' });
        collector.handleRecord({ type: 'delta', text: 'Hello' });
        collector.handleRecord({ type: 'speaker_end', character_id: 'char-monica', participant_id: 'part-monica' });
        collector.handleRecord({ type: 'done' });
        const messages = collector.getMessages();
        assert.equal(messages.length, 1);
        assert.equal(messages[0].role, 'assistant');
        assert.equal(messages[0].character_id, 'char-monica');
        assert.equal(messages[0].content, 'Hello');
    });

    test('two streamed speakers produce two distinct messages with distinct identities', () => {
        const collector = createStreamMessageCollector();
        const start1 = collector.handleRecord({ type: 'speaker_start', character_id: 'char-doug' });
        collector.handleRecord({ type: 'delta', text: 'Hello from Doug' });
        collector.handleRecord({ type: 'speaker_end', character_id: 'char-doug' });
        const start2 = collector.handleRecord({ type: 'speaker_start', character_id: 'char-monica' });
        collector.handleRecord({ type: 'delta', text: 'Hello from Monica' });
        collector.handleRecord({ type: 'speaker_end', character_id: 'char-monica' });
        collector.handleRecord({ type: 'done' });
        assert.equal(start1.isNewMessage, false);
        assert.equal(start2.isNewMessage, true);
        const messages = collector.getMessages();
        assert.equal(messages.length, 2);
        assert.equal(messages[0].character_id, 'char-doug');
        assert.equal(messages[0].content, 'Hello from Doug');
        assert.equal(messages[1].character_id, 'char-monica');
        assert.equal(messages[1].content, 'Hello from Monica');
    });

    test('deltas before any speaker_start attach to the pending message', () => {
        const collector = createStreamMessageCollector();
        const pending = collector.getPendingMessage();
        collector.handleRecord({ type: 'delta', text: 'standalone ' });
        collector.handleRecord({ type: 'delta', text: 'reply' });
        const messages = collector.getMessages();
        assert.equal(messages.length, 1);
        assert.equal(messages[0], pending);
        assert.equal(messages[0].content, 'standalone reply');
        assert.ok(!('character_id' in messages[0]), 'identity stays unset until speaker_start');
    });

    test('error record appends a safe error line to the current message', () => {
        const collector = createStreamMessageCollector();
        collector.handleRecord({ type: 'speaker_start', character_id: 'char-doug' });
        collector.handleRecord({ type: 'delta', text: 'partial ' });
        collector.handleRecord({ type: 'error', error: 'upstream failed' });
        const messages = collector.getMessages();
        assert.equal(messages.length, 1);
        assert.equal(messages[0].content, 'partial \nupstream failed');
    });

    test('error record without message falls back to a generic line', () => {
        const collector = createStreamMessageCollector();
        collector.handleRecord({ type: 'error', error: '' });
        const messages = collector.getMessages();
        assert.equal(messages[0].content, '\nStream error');
    });

    test('unknown or malformed records are ignored', () => {
        const collector = createStreamMessageCollector();
        assert.equal(collector.handleRecord({ type: 'unknown' }), null);
        assert.equal(collector.handleRecord(null), null);
        assert.equal(collector.handleRecord('text'), null);
        const messages = collector.getMessages();
        assert.equal(messages.length, 1);
        assert.equal(messages[0].content, '');
    });
});
