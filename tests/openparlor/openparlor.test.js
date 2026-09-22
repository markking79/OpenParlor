import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeMemory,
    normalizeMemorySource,
    validateMemoryForm,
    normalizeParticipants,
    normalizeConversation,
    createGroupPlaybackQueue,
    normalizeSettings,
    normalizeHealthStatus,
} from '../../public/openparlor/openparlor.js';

describe('normalizeMemory', () => {
    it('should normalize a valid memory object', () => {
        const raw = {
            id: 'mem-1',
            character_id: 'char-1',
            content: 'User likes coffee',
            type: 'preference',
            importance: 0.8,
            pinned: true,
            source_conversation_id: 'conv-1',
            source_conversation_title: 'Morning chat',
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-02T00:00:00Z',
        };
        const result = normalizeMemory(raw);
        assert.equal(result.id, 'mem-1');
        assert.equal(result.characterId, 'char-1');
        assert.equal(result.content, 'User likes coffee');
        assert.equal(result.type, 'preference');
        assert.equal(result.importance, 0.8);
        assert.equal(result.pinned, true);
        assert.equal(result.sourceConversationId, 'conv-1');
        assert.equal(result.sourceConversationTitle, 'Morning chat');
        assert.equal(result.createdAt, '2024-01-01T00:00:00Z');
        assert.equal(result.updatedAt, '2024-01-02T00:00:00Z');
    });

    it('should return null for null input', () => {
        assert.equal(normalizeMemory(null), null);
    });

    it('should return null for non-object input', () => {
        assert.equal(normalizeMemory('string'), null);
        assert.equal(normalizeMemory(42), null);
    });

    it('should handle missing fields with defaults', () => {
        const result = normalizeMemory({ id: 123 });
        assert.equal(result.id, '123');
        assert.equal(result.characterId, '');
        assert.equal(result.content, '');
        assert.equal(result.type, 'fact');
        assert.equal(result.importance, 0.5);
        assert.equal(result.pinned, false);
        assert.equal(result.sourceConversationId, '');
        assert.equal(result.sourceConversationTitle, '');
    });

    it('should clamp importance to the persistence 0-1 range', () => {
        assert.equal(normalizeMemory({ id: '1', importance: -1 }).importance, 0);
        assert.equal(normalizeMemory({ id: '1', importance: 10 }).importance, 1);
        assert.equal(normalizeMemory({ id: '1', importance: 0.37 }).importance, 0.37);
    });

    it('should not leak filesystem paths or provider config', () => {
        const raw = {
            id: 'mem-1',
            content: 'test',
            file_path: '/etc/passwd',
            provider_config: { api_key: 'secret' },
        };
        const result = normalizeMemory(raw);
        assert.equal(result.file_path, undefined);
        assert.equal(result.provider_config, undefined);
        assert.equal(result.content, 'test');
    });
});

describe('normalizeMemorySource', () => {
    const conversations = [
        { id: 'conv-1', title: 'Morning chat' },
        { id: 'conv-2', title: 'Evening talk' },
    ];

    it('should return label and available=true when source conversation exists', () => {
        const memory = { sourceConversationId: 'conv-1' };
        const result = normalizeMemorySource(memory, conversations);
        assert.equal(result.label, 'Morning chat');
        assert.equal(result.available, true);
    });

    it('should return "No source" when memory has no source conversation', () => {
        const memory = { sourceConversationId: '' };
        const result = normalizeMemorySource(memory, conversations);
        assert.equal(result.label, 'No source');
        assert.equal(result.available, false);
    });

    it('should return "Source unavailable" when conversation is not found', () => {
        const memory = { sourceConversationId: 'conv-999' };
        const result = normalizeMemorySource(memory, conversations);
        assert.equal(result.label, 'Source unavailable');
        assert.equal(result.available, false);
    });

    it('should handle null memory gracefully', () => {
        const result = normalizeMemorySource(null, conversations);
        assert.equal(result.label, '');
        assert.equal(result.available, false);
    });

    it('should handle null conversations array', () => {
        const memory = { sourceConversationId: 'conv-1' };
        const result = normalizeMemorySource(memory, null);
        assert.equal(result.label, 'Source unavailable');
        assert.equal(result.available, false);
    });

    it('should not expose conversation id in the label', () => {
        const memory = { sourceConversationId: 'conv-1' };
        const result = normalizeMemorySource(memory, conversations);
        assert.ok(!result.label.includes('conv-1'));
    });
});

describe('normalizeParticipants', () => {
    it('should normalize a valid participants array', () => {
        const raw = [
            { id: 'participant-1', character_id: 'char-1', role: 'character' },
            { id: 'participant-2', character_id: 'char-2', role: 'character' },
        ];
        const result = normalizeParticipants(raw);
        assert.equal(result.length, 2);
        assert.equal(result[0].characterId, 'char-1');
        assert.equal(result[0].role, 'character');
        assert.equal(result[1].characterId, 'char-2');
    });

    it('should return empty array for null or non-array input', () => {
        assert.deepEqual(normalizeParticipants(null), []);
        assert.deepEqual(normalizeParticipants(undefined), []);
        assert.deepEqual(normalizeParticipants('string'), []);
    });

    it('should filter out invalid entries', () => {
        const raw = [
            { character_id: 'char-1', role: 'character' },
            null,
            'invalid',
            { character_id: '', role: 'character' },
            { role: 'character' },
        ];
        const result = normalizeParticipants(raw);
        assert.equal(result.length, 1);
        assert.equal(result[0].characterId, 'char-1');
    });

    it('should default role to "character" when missing', () => {
        const result = normalizeParticipants([{ character_id: 'char-1' }]);
        assert.equal(result[0].role, 'character');
    });
});

describe('normalizeConversation', () => {
    it('should include participants in normalized output', () => {
        const raw = {
            id: 'conv-1',
            title: 'Test',
            character_id: 'char-1',
            participants: [{ id: 'participant-1', character_id: 'char-1', role: 'character' }],
            updated_at: '2024-01-01T00:00:00Z',
        };
        const result = normalizeConversation(raw);
        assert.equal(result.participants.length, 1);
        assert.equal(result.participants[0].characterId, 'char-1');
    });

    it('should default participants to empty array when missing', () => {
        const result = normalizeConversation({ id: 'conv-1', title: 'T' });
        assert.deepEqual(result.participants, []);
    });
});

describe('validateMemoryForm', () => {
    it('should accept valid form data', () => {
        const result = validateMemoryForm({
            content: 'User prefers dark mode',
            type: 'preference',
            importance: 0.8,
        });
        assert.equal(result.valid, true);
        assert.equal(result.errors.length, 0);
        assert.equal(result.content, 'User prefers dark mode');
        assert.equal(result.type, 'preference');
        assert.equal(result.importance, 0.8);
    });

    it('should reject empty content', () => {
        const result = validateMemoryForm({ content: '', type: 'fact', importance: 0.5 });
        assert.equal(result.valid, false);
        assert.ok(result.errors.some(e => e.includes('Content is required')));
    });

    it('should reject whitespace-only content', () => {
        const result = validateMemoryForm({ content: '   ', type: 'fact', importance: 0.5 });
        assert.equal(result.valid, false);
    });

    it('should reject content over 2000 characters', () => {
        const result = validateMemoryForm({
            content: 'a'.repeat(2001),
            type: 'fact',
            importance: 0.5,
        });
        assert.equal(result.valid, false);
        assert.ok(result.errors.some(e => e.includes('2000')));
    });

    it('should accept content at exactly 2000 characters', () => {
        const result = validateMemoryForm({
            content: 'a'.repeat(2000),
            type: 'fact',
            importance: 0.5,
        });
        assert.equal(result.valid, true);
    });

    it('should reject invalid type', () => {
        const result = validateMemoryForm({ content: 'test', type: 'invalid_type', importance: 0.5 });
        assert.equal(result.valid, false);
        assert.ok(result.errors.some(e => e.includes('Invalid type')));
    });

    it('should accept all valid types', () => {
        for (const type of ['fact', 'preference', 'event', 'relationship', 'other']) {
            const result = validateMemoryForm({ content: 'test', type, importance: 0.5 });
            assert.equal(result.valid, true, `Type ${type} should be valid`);
        }
    });

    it('should reject importance below 0', () => {
        const result = validateMemoryForm({ content: 'test', type: 'fact', importance: -0.1 });
        assert.equal(result.valid, false);
        assert.ok(result.errors.some(e => e.includes('Importance')));
    });

    it('should reject importance above 1', () => {
        const result = validateMemoryForm({ content: 'test', type: 'fact', importance: 1.1 });
        assert.equal(result.valid, false);
    });

    it('should reject non-numeric importance', () => {
        const result = validateMemoryForm({ content: 'test', type: 'fact', importance: 'high' });
        assert.equal(result.valid, false);
    });

    it('should handle null input', () => {
        const result = validateMemoryForm(null);
        assert.equal(result.valid, false);
    });

    it('should handle non-object input', () => {
        const result = validateMemoryForm('string');
        assert.equal(result.valid, false);
    });
});

describe('normalizeSettings', () => {
    it('should normalize valid settings with all sections', () => {
        const raw = {
            model: { provider: 'openai', model: 'gpt-4', connected: true },
            speech: { voicesAvailable: true, voiceModeEnabled: false },
            character: { defaultCharacterId: 'char-1', count: 3 },
        };
        const result = normalizeSettings(raw);
        assert.deepEqual(result.model, { provider: 'openai', model: 'gpt-4', connected: true });
        assert.deepEqual(result.speech, { voicesAvailable: true, voiceModeEnabled: false });
        assert.deepEqual(result.character, { defaultCharacterId: 'char-1', count: 3 });
    });

    it('should return null sections for null input', () => {
        const result = normalizeSettings(null);
        assert.equal(result.model, null);
        assert.equal(result.speech, null);
        assert.equal(result.character, null);
    });

    it('should return null sections for non-object input', () => {
        const result = normalizeSettings('string');
        assert.equal(result.model, null);
        assert.equal(result.speech, null);
        assert.equal(result.character, null);
    });

    it('should handle missing sections gracefully', () => {
        const result = normalizeSettings({});
        assert.equal(result.model, null);
        assert.equal(result.speech, null);
        assert.equal(result.character, null);
    });

    it('should not leak endpoint URLs', () => {
        const raw = {
            model: {
                provider: 'openai',
                model: 'gpt-4',
                connected: true,
                endpoint: 'https://api.openai.com/v1',
                base_url: 'http://localhost:8080',
            },
        };
        const result = normalizeSettings(raw);
        assert.equal(result.model.endpoint, undefined);
        assert.equal(result.model.base_url, undefined);
        assert.equal(result.model.provider, 'openai');
    });

    it('should not leak credentials or API keys', () => {
        const raw = {
            model: {
                provider: 'openai',
                model: 'gpt-4',
                connected: true,
                api_key: 'sk-secret-123',
                credentials: { token: 'abc' },
                provider_config: { api_key: 'sk-other' },
            },
            speech: {
                voicesAvailable: true,
                voiceModeEnabled: false,
                stt_api_key: 'stt-secret',
            },
        };
        const result = normalizeSettings(raw);
        assert.equal(result.model.api_key, undefined);
        assert.equal(result.model.credentials, undefined);
        assert.equal(result.model.provider_config, undefined);
        assert.equal(result.speech.stt_api_key, undefined);
    });

    it('should not leak filesystem paths', () => {
        const raw = {
            model: {
                provider: 'local',
                model: 'llama',
                connected: true,
                file_path: '/models/llama-7b.gguf',
                model_path: '/opt/models/llama',
            },
            character: {
                defaultCharacterId: 'char-1',
                count: 2,
                avatar_dir: '/var/avatars',
            },
        };
        const result = normalizeSettings(raw);
        assert.equal(result.model.file_path, undefined);
        assert.equal(result.model.model_path, undefined);
        assert.equal(result.character.avatar_dir, undefined);
    });

    it('should default model fields to safe values when types are wrong', () => {
        const result = normalizeSettings({
            model: { provider: 42, model: null, connected: 'yes' },
        });
        assert.deepEqual(result.model, { provider: '', model: '', connected: false });
    });

    it('should default speech fields to false when types are wrong', () => {
        const result = normalizeSettings({
            speech: { voicesAvailable: 'yes', voiceModeEnabled: 1 },
        });
        assert.deepEqual(result.speech, { voicesAvailable: false, voiceModeEnabled: false });
    });

    it('should clamp character count to non-negative integer', () => {
        assert.equal(normalizeSettings({ character: { count: -5 } }).character.count, 0);
        assert.equal(normalizeSettings({ character: { count: 3.7 } }).character.count, 3);
        assert.equal(normalizeSettings({ character: { count: 'ten' } }).character.count, 0);
        assert.equal(normalizeSettings({ character: { count: Infinity } }).character.count, 0);
    });

    it('should handle non-object section values as null', () => {
        const result = normalizeSettings({
            model: 'not-an-object',
            speech: 42,
            character: null,
        });
        assert.equal(result.model, null);
        assert.equal(result.speech, null);
        assert.equal(result.character, null);
    });
});

describe('normalizeHealthStatus', () => {
    it('should normalize valid health with all services available', () => {
        const raw = {
            model: { available: true, label: 'gpt-4' },
            tts: { available: true, label: 'Piper' },
            stt: { available: true, label: 'Whisper' },
        };
        const result = normalizeHealthStatus(raw);
        assert.deepEqual(result.model, { available: true, label: 'gpt-4' });
        assert.deepEqual(result.tts, { available: true, label: 'Piper' });
        assert.deepEqual(result.stt, { available: true, label: 'Whisper' });
    });

    it('should return null sections for null input', () => {
        const result = normalizeHealthStatus(null);
        assert.equal(result.model, null);
        assert.equal(result.tts, null);
        assert.equal(result.stt, null);
    });

    it('should return null sections for non-object input', () => {
        const result = normalizeHealthStatus('string');
        assert.equal(result.model, null);
        assert.equal(result.tts, null);
        assert.equal(result.stt, null);
    });

    it('should handle missing sections gracefully', () => {
        const result = normalizeHealthStatus({});
        assert.equal(result.model, null);
        assert.equal(result.tts, null);
        assert.equal(result.stt, null);
    });

    it('should handle non-object section values as null', () => {
        const result = normalizeHealthStatus({
            model: 'not-an-object',
            tts: 42,
            stt: null,
        });
        assert.equal(result.model, null);
        assert.equal(result.tts, null);
        assert.equal(result.stt, null);
    });

    it('should not leak endpoint URLs or credentials', () => {
        const raw = {
            model: {
                available: true,
                label: 'gpt-4',
                endpoint: 'https://api.openai.com/v1',
                api_key: 'sk-secret',
                base_url: 'http://localhost:8080',
            },
            tts: {
                available: true,
                label: 'Piper',
                model_path: '/opt/models/piper',
                credentials: { token: 'abc' },
            },
            stt: {
                available: true,
                label: 'Whisper',
                stt_api_key: 'stt-secret',
                file_path: '/models/whisper',
            },
        };
        const result = normalizeHealthStatus(raw);
        assert.equal(result.model.endpoint, undefined);
        assert.equal(result.model.api_key, undefined);
        assert.equal(result.model.base_url, undefined);
        assert.equal(result.tts.model_path, undefined);
        assert.equal(result.tts.credentials, undefined);
        assert.equal(result.stt.stt_api_key, undefined);
        assert.equal(result.stt.file_path, undefined);
    });

    it('should default available to false when not explicitly true', () => {
        const result = normalizeHealthStatus({
            model: { available: 'yes', label: 'test' },
            tts: { label: 'test' },
            stt: { available: 1, label: 'test' },
        });
        assert.equal(result.model.available, false);
        assert.equal(result.tts.available, false);
        assert.equal(result.stt.available, false);
    });

    it('should default label to empty string when not a string', () => {
        const result = normalizeHealthStatus({
            model: { available: true, label: 42 },
            tts: { available: true },
            stt: { available: true, label: null },
        });
        assert.equal(result.model.label, '');
        assert.equal(result.tts.label, '');
        assert.equal(result.stt.label, '');
    });
});

describe('createGroupPlaybackQueue', () => {
    it('should play items in enqueue order', async () => {
        const played = [];
        const queue = createGroupPlaybackQueue({
            playItem: async (text, voice) => { played.push({ text, voice }); },
        });
        queue.enqueue('Hello', 'voice-a');
        queue.enqueue('World', 'voice-b');
        queue.enqueue('!', 'voice-c');
        await queue.playAll();
        assert.equal(played.length, 3);
        assert.equal(played[0].text, 'Hello');
        assert.equal(played[0].voice, 'voice-a');
        assert.equal(played[1].text, 'World');
        assert.equal(played[1].voice, 'voice-b');
        assert.equal(played[2].text, '!');
        assert.equal(played[2].voice, 'voice-c');
    });

    it('should handle single item (one-on-one regression)', async () => {
        const played = [];
        const queue = createGroupPlaybackQueue({
            playItem: async (text, voice) => { played.push({ text, voice }); },
        });
        queue.enqueue('Only message', 'voice-x');
        await queue.playAll();
        assert.equal(played.length, 1);
        assert.equal(played[0].text, 'Only message');
        assert.equal(played[0].voice, 'voice-x');
    });

    it('should skip items with empty text or voice', () => {
        const queue = createGroupPlaybackQueue({ playItem: async () => {} });
        queue.enqueue('', 'voice-a');
        queue.enqueue('   ', 'voice-b');
        queue.enqueue('text', '');
        queue.enqueue(null, 'voice-c');
        queue.enqueue(undefined, 'voice-d');
        assert.equal(queue.pending, 0);
    });

    it('should clear pending items and stop subsequent playback', async () => {
        const played = [];
        let resolveFirst;
        const queue = createGroupPlaybackQueue({
            playItem: (text, voice) => {
                played.push(text);
                if (text === 'first') {
                    return new Promise(r => { resolveFirst = r; });
                }
                return Promise.resolve();
            },
        });
        queue.enqueue('first', 'v1');
        queue.enqueue('second', 'v2');
        queue.enqueue('third', 'v3');
        const playPromise = queue.playAll();
        await new Promise(r => setTimeout(r, 10));
        assert.equal(played.length, 1);
        queue.clear();
        resolveFirst();
        await playPromise;
        assert.equal(played.length, 1);
        assert.equal(queue.pending, 0);
        assert.equal(queue.isPlaying, false);
    });

    it('should call onAllDone when all items complete successfully', async () => {
        let doneCalled = false;
        const queue = createGroupPlaybackQueue({
            playItem: async () => {},
            onAllDone: () => { doneCalled = true; },
        });
        queue.enqueue('a', 'v1');
        queue.enqueue('b', 'v2');
        await queue.playAll();
        assert.equal(doneCalled, true);
    });

    it('should not call onAllDone if cleared mid-playback', async () => {
        let doneCalled = false;
        let resolveFirst;
        const queue = createGroupPlaybackQueue({
            playItem: (text) => {
                if (text === 'a') return new Promise(r => { resolveFirst = r; });
                return Promise.resolve();
            },
            onAllDone: () => { doneCalled = true; },
        });
        queue.enqueue('a', 'v1');
        queue.enqueue('b', 'v2');
        const playPromise = queue.playAll();
        await new Promise(r => setTimeout(r, 10));
        queue.clear();
        resolveFirst();
        await playPromise;
        assert.equal(doneCalled, false);
    });

    it('should not call onAllDone if playItem rejects', async () => {
        let doneCalled = false;
        const queue = createGroupPlaybackQueue({
            playItem: async () => { throw new Error('TTS failed'); },
            onAllDone: () => { doneCalled = true; },
        });
        queue.enqueue('a', 'v1');
        await queue.playAll();
        assert.equal(doneCalled, false);
        assert.equal(queue.isPlaying, false);
        assert.equal(queue.pending, 0);
    });

    it('should report isPlaying and pending correctly', async () => {
        let resolveItem;
        const queue = createGroupPlaybackQueue({
            playItem: () => new Promise(r => { resolveItem = r; }),
        });
        assert.equal(queue.isPlaying, false);
        assert.equal(queue.pending, 0);
        queue.enqueue('test', 'v1');
        assert.equal(queue.pending, 1);
        const playPromise = queue.playAll();
        await new Promise(r => setTimeout(r, 10));
        assert.equal(queue.isPlaying, true);
        resolveItem();
        await playPromise;
        assert.equal(queue.isPlaying, false);
        assert.equal(queue.pending, 0);
    });

    it('should do nothing when playAll is called with empty queue', async () => {
        let doneCalled = false;
        const queue = createGroupPlaybackQueue({
            playItem: async () => { throw new Error('should not be called'); },
            onAllDone: () => { doneCalled = true; },
        });
        await queue.playAll();
        assert.equal(doneCalled, false);
        assert.equal(queue.isPlaying, false);
    });
});
