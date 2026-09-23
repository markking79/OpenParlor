import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeMemory,
    normalizeMemorySource,
    validateMemoryForm,
    normalizeParticipants,
    normalizeConversation,
    resolveMessageCharacterId,
    createGroupPlaybackQueue,
    normalizeSettings,
    normalizeHealthStatus,
    normalizeServiceError,
    normalizeModelStatus,
    normalizeTtsVoices,
    normalizeChatReadiness,
    normalizeAudioReadiness,
    checkLocalReadiness,
    normalizeDeferredPrerequisite,
    fetchDeferredPrerequisite,
    selectSupportedMime,
    shouldAutoSendTranscription,
    shouldAutoSpeak,
    createVoiceTurnTimer,
    createRecorderController,
    createTranscriptionController,
    createPlaybackController,
    createNdjsonParser,
    normalizeCharacter,
    sanitizeCharacterInput,
    resolveBrowserUrl,
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
        assert.equal(result[0].id, 'participant-1');
        assert.equal(result[0].characterId, 'char-1');
        assert.equal(result[0].role, 'character');
        assert.equal(result[1].id, 'participant-2');
        assert.equal(result[1].characterId, 'char-2');
    });

    it('should accept browser-style participantId as the record id', () => {
        const raw = [
            { participantId: 'part-abc', character_id: 'char-1', role: 'character' },
        ];
        const result = normalizeParticipants(raw);
        assert.equal(result.length, 1);
        assert.equal(result[0].id, 'part-abc');
        assert.equal(result[0].characterId, 'char-1');
    });

    it('should default id to empty string when missing', () => {
        const raw = [{ character_id: 'char-1', role: 'character' }];
        const result = normalizeParticipants(raw);
        assert.equal(result[0].id, '');
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
        assert.equal(result[0].id, '');
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
        assert.equal(result.participants[0].id, 'participant-1');
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

describe('normalizeChatReadiness', () => {
    it('should report ready when model is connected and health is available', () => {
        const modelStatus = { provider: 'ollama', model: 'llama3', endpointLabel: 'Local', models: ['llama3'], connected: true };
        const healthStatus = { model: { available: true, label: 'llama3' }, tts: { available: true, label: 'Piper' }, stt: { available: true, label: 'Whisper' } };
        const result = normalizeChatReadiness(modelStatus, healthStatus);
        assert.equal(result.ready, true);
        assert.equal(result.reason, '');
    });

    it('should report not ready when model is not connected', () => {
        const modelStatus = { provider: 'openai', model: 'gpt-4', endpointLabel: '', models: [], connected: false };
        const healthStatus = { model: { available: false, label: '' }, tts: null, stt: null };
        const result = normalizeChatReadiness(modelStatus, healthStatus);
        assert.equal(result.ready, false);
        assert.equal(result.reason, 'Model not connected');
    });

    it('should report not ready when model status is null', () => {
        const result = normalizeChatReadiness(null, null);
        assert.equal(result.ready, false);
        assert.equal(result.reason, 'Model not connected');
    });

    it('should report not ready when model status is non-object', () => {
        const result = normalizeChatReadiness('invalid', null);
        assert.equal(result.ready, false);
        assert.equal(result.reason, 'Model not connected');
    });

    it('should report not ready when health explicitly says model unavailable', () => {
        const modelStatus = { provider: 'ollama', model: 'llama3', endpointLabel: 'Local', models: ['llama3'], connected: true };
        const healthStatus = { model: { available: false, label: 'llama3' }, tts: null, stt: null };
        const result = normalizeChatReadiness(modelStatus, healthStatus);
        assert.equal(result.ready, false);
        assert.equal(result.reason, 'Model service unavailable');
    });

    it('should report ready when health is null but model is connected', () => {
        const modelStatus = { provider: 'ollama', model: 'llama3', endpointLabel: 'Local', models: ['llama3'], connected: true };
        const result = normalizeChatReadiness(modelStatus, null);
        assert.equal(result.ready, true);
        assert.equal(result.reason, '');
    });

    it('should report ready when health model section is null but model is connected', () => {
        const modelStatus = { provider: 'ollama', model: 'llama3', endpointLabel: 'Local', models: ['llama3'], connected: true };
        const healthStatus = { model: null, tts: null, stt: null };
        const result = normalizeChatReadiness(modelStatus, healthStatus);
        assert.equal(result.ready, true);
        assert.equal(result.reason, '');
    });

    it('should not leak endpoint URLs in reason', () => {
        const modelStatus = { provider: 'openai', model: 'gpt-4', endpointLabel: 'https://api.openai.com/v1', models: [], connected: false };
        const result = normalizeChatReadiness(modelStatus, null);
        assert.equal(result.ready, false);
        assert.ok(!result.reason.includes('http'));
    });
});

describe('normalizeAudioReadiness', () => {
    it('should report both stt and tts ready when both are available', () => {
        const health = {
            model: { available: true, label: 'llama3' },
            tts: { available: true, label: 'Piper' },
            stt: { available: true, label: 'Whisper' },
        };
        const result = normalizeAudioReadiness(health);
        assert.equal(result.stt, true);
        assert.equal(result.tts, true);
        assert.equal(result.ready, true);
    });

    it('should report not ready when stt is unavailable', () => {
        const health = {
            model: { available: true, label: 'llama3' },
            tts: { available: true, label: 'Piper' },
            stt: { available: false, label: '' },
        };
        const result = normalizeAudioReadiness(health);
        assert.equal(result.stt, false);
        assert.equal(result.tts, true);
        assert.equal(result.ready, false);
    });

    it('should report not ready when tts is unavailable', () => {
        const health = {
            model: { available: true, label: 'llama3' },
            tts: { available: false, label: '' },
            stt: { available: true, label: 'Whisper' },
        };
        const result = normalizeAudioReadiness(health);
        assert.equal(result.stt, true);
        assert.equal(result.tts, false);
        assert.equal(result.ready, false);
    });

    it('should report not ready when both are unavailable', () => {
        const health = {
            model: { available: true, label: 'llama3' },
            tts: { available: false, label: '' },
            stt: { available: false, label: '' },
        };
        const result = normalizeAudioReadiness(health);
        assert.equal(result.stt, false);
        assert.equal(result.tts, false);
        assert.equal(result.ready, false);
    });

    it('should report not ready for null input', () => {
        const result = normalizeAudioReadiness(null);
        assert.equal(result.stt, false);
        assert.equal(result.tts, false);
        assert.equal(result.ready, false);
    });

    it('should report not ready for non-object input', () => {
        const result = normalizeAudioReadiness('invalid');
        assert.equal(result.stt, false);
        assert.equal(result.tts, false);
        assert.equal(result.ready, false);
    });

    it('should report not ready when stt section is null', () => {
        const health = { model: null, tts: { available: true, label: 'Piper' }, stt: null };
        const result = normalizeAudioReadiness(health);
        assert.equal(result.stt, false);
        assert.equal(result.tts, true);
        assert.equal(result.ready, false);
    });

    it('should report not ready when tts section is null', () => {
        const health = { model: null, tts: null, stt: { available: true, label: 'Whisper' } };
        const result = normalizeAudioReadiness(health);
        assert.equal(result.stt, true);
        assert.equal(result.tts, false);
        assert.equal(result.ready, false);
    });

    it('should not treat non-boolean available as true', () => {
        const health = {
            model: null,
            tts: { available: 'yes', label: 'Piper' },
            stt: { available: 1, label: 'Whisper' },
        };
        const result = normalizeAudioReadiness(health);
        assert.equal(result.stt, false);
        assert.equal(result.tts, false);
        assert.equal(result.ready, false);
    });
});

describe('checkLocalReadiness', () => {
    const readyModel = { provider: 'ollama', model: 'llama3', endpointLabel: 'Local', models: ['llama3'], connected: true };
    const readyHealth = { model: { available: true, label: 'llama3' }, tts: { available: true, label: 'Piper' }, stt: { available: true, label: 'Whisper' } };
    const satisfiedPrereq = { satisfied: true, label: 'Storage state found' };

    it('should report ready when all services are available and prerequisite is satisfied', () => {
        const result = checkLocalReadiness({ modelStatus: readyModel, healthStatus: readyHealth, prerequisite: satisfiedPrereq });
        assert.equal(result.ready, true);
        assert.equal(result.blockers.length, 0);
        assert.equal(result.model.ready, true);
        assert.equal(result.audio.ready, true);
        assert.equal(result.prerequisite.deferred, false);
    });

    it('should report not ready when model is not connected', () => {
        const result = checkLocalReadiness({
            modelStatus: { provider: 'openai', model: 'gpt-4', endpointLabel: '', models: [], connected: false },
            healthStatus: readyHealth,
            prerequisite: satisfiedPrereq,
        });
        assert.equal(result.ready, false);
        assert.ok(result.blockers.includes('Model not connected'));
    });

    it('should report not ready when prerequisite is deferred', () => {
        const result = checkLocalReadiness({
            modelStatus: readyModel,
            healthStatus: readyHealth,
            prerequisite: { satisfied: false, label: 'Developer storage state not found' },
        });
        assert.equal(result.ready, false);
        assert.ok(result.blockers.includes('Developer storage state not found'));
        assert.equal(result.prerequisite.deferred, true);
    });

    it('should report not ready when both model and prerequisite block', () => {
        const result = checkLocalReadiness({
            modelStatus: null,
            healthStatus: null,
            prerequisite: null,
        });
        assert.equal(result.ready, false);
        assert.equal(result.blockers.length, 2);
        assert.ok(result.blockers.includes('Model not connected'));
        assert.ok(result.blockers.includes('Prerequisite not met'));
    });

    it('should report audio readiness independently of model readiness', () => {
        const result = checkLocalReadiness({
            modelStatus: readyModel,
            healthStatus: { model: { available: true, label: 'llama3' }, tts: { available: false, label: '' }, stt: { available: false, label: '' } },
            prerequisite: satisfiedPrereq,
        });
        assert.equal(result.ready, true);
        assert.equal(result.audio.ready, false);
        assert.equal(result.audio.stt, false);
        assert.equal(result.audio.tts, false);
    });

    it('should handle null params object gracefully', () => {
        const result = checkLocalReadiness();
        assert.equal(result.ready, false);
        assert.equal(result.model.ready, false);
        assert.equal(result.audio.ready, false);
        assert.equal(result.prerequisite.deferred, true);
    });

    it('should not leak endpoint URLs or credentials in blockers', () => {
        const result = checkLocalReadiness({
            modelStatus: { provider: 'openai', model: 'gpt-4', endpointLabel: 'https://api.openai.com/v1', models: [], connected: false },
            healthStatus: null,
            prerequisite: { satisfied: false, label: 'State at /home/dev/.openparlor/storage-state.json missing' },
        });
        for (const blocker of result.blockers) {
            assert.ok(!blocker.includes('http'));
            assert.ok(!blocker.includes('/home/dev'));
        }
    });

    it('should not require CSRF or mutation for read-only check', () => {
        // checkLocalReadiness is a pure function — no fetch, no CSRF token needed
        const result = checkLocalReadiness({ modelStatus: readyModel, healthStatus: readyHealth, prerequisite: satisfiedPrereq });
        assert.equal(result.ready, true);
    });
});

describe('normalizeDeferredPrerequisite', () => {
    it('should return deferred=false when satisfied is true', () => {
        const result = normalizeDeferredPrerequisite({ satisfied: true, label: 'Storage state found' });
        assert.equal(result.deferred, false);
        assert.equal(result.label, '');
    });

    it('should return deferred=true with label when satisfied is false', () => {
        const result = normalizeDeferredPrerequisite({ satisfied: false, label: 'Developer storage state not found' });
        assert.equal(result.deferred, true);
        assert.equal(result.label, 'Developer storage state not found');
    });

    it('should return deferred=true with fallback label for null input', () => {
        const result = normalizeDeferredPrerequisite(null);
        assert.equal(result.deferred, true);
        assert.equal(result.label, 'Prerequisite not met');
    });

    it('should return deferred=true with fallback label for non-object input', () => {
        assert.equal(normalizeDeferredPrerequisite('string').deferred, true);
        assert.equal(normalizeDeferredPrerequisite(42).deferred, true);
        assert.equal(normalizeDeferredPrerequisite(undefined).deferred, true);
    });

    it('should return deferred=true when satisfied is not explicitly true', () => {
        assert.equal(normalizeDeferredPrerequisite({ satisfied: 'yes' }).deferred, true);
        assert.equal(normalizeDeferredPrerequisite({ satisfied: 1 }).deferred, true);
        assert.equal(normalizeDeferredPrerequisite({}).deferred, true);
    });

    it('should redact URLs from the label', () => {
        const result = normalizeDeferredPrerequisite({ satisfied: false, label: 'Missing state at http://localhost:3000/session' });
        assert.equal(result.deferred, true);
        assert.ok(!result.label.includes('http'));
        assert.ok(result.label.includes('[redacted]'));
    });

    it('should redact file URLs from the label', () => {
        const result = normalizeDeferredPrerequisite({ satisfied: false, label: 'State file:///home/user/.state.json missing' });
        assert.equal(result.deferred, true);
        assert.ok(!result.label.includes('file://'));
    });

    it('should redact filesystem paths from the label', () => {
        const result = normalizeDeferredPrerequisite({ satisfied: false, label: 'No state at /var/lib/app/session.json' });
        assert.equal(result.deferred, true);
        assert.ok(!result.label.includes('/var/lib'));
    });

    it('should redact credential patterns from the label', () => {
        const result = normalizeDeferredPrerequisite({ satisfied: false, label: 'token=abc123secret not valid' });
        assert.equal(result.deferred, true);
        assert.ok(!result.label.includes('abc123secret'));
    });

    it('should use fallback label when label is empty after redaction', () => {
        const result = normalizeDeferredPrerequisite({ satisfied: false, label: 'http://only-a-url.com' });
        assert.equal(result.deferred, true);
        assert.equal(result.label, 'Prerequisite not met');
    });

    it('should use fallback label when label is not a string', () => {
        const result = normalizeDeferredPrerequisite({ satisfied: false, label: 42 });
        assert.equal(result.deferred, true);
        assert.equal(result.label, 'Prerequisite not met');
    });
});

describe('fetchDeferredPrerequisite', () => {
    it('should return normalized result on successful response', async () => {
        const result = await fetchDeferredPrerequisite({
            fetchFn: async () => ({
                ok: true,
                json: async () => ({ satisfied: false, label: 'Developer storage state not found' }),
            }),
        });
        assert.equal(result.deferred, true);
        assert.equal(result.label, 'Developer storage state not found');
    });

    it('should return non-deferred when satisfied is true', async () => {
        const result = await fetchDeferredPrerequisite({
            fetchFn: async () => ({
                ok: true,
                json: async () => ({ satisfied: true, label: 'Storage state found' }),
            }),
        });
        assert.equal(result.deferred, false);
        assert.equal(result.label, '');
    });

    it('should return fallback on non-ok response', async () => {
        const result = await fetchDeferredPrerequisite({
            fetchFn: async () => ({ ok: false, json: async () => ({}) }),
        });
        assert.equal(result.deferred, true);
        assert.equal(result.label, 'Prerequisite not met');
    });

    it('should return fallback on network error', async () => {
        const result = await fetchDeferredPrerequisite({
            fetchFn: async () => { throw new Error('network down'); },
        });
        assert.equal(result.deferred, true);
        assert.equal(result.label, 'Prerequisite not met');
    });

    it('should return fallback on non-object JSON response', async () => {
        const result = await fetchDeferredPrerequisite({
            fetchFn: async () => ({
                ok: true,
                json: async () => 'not-an-object',
            }),
        });
        assert.equal(result.deferred, true);
        assert.equal(result.label, 'Prerequisite not met');
    });

    it('should redact sensitive content from labels', async () => {
        const result = await fetchDeferredPrerequisite({
            fetchFn: async () => ({
                ok: true,
                json: async () => ({ satisfied: false, label: 'Missing state at /home/dev/.openparlor/storage-state.json' }),
            }),
        });
        assert.equal(result.deferred, true);
        assert.ok(!result.label.includes('/home/dev'));
    });

    it('should call the correct endpoint', async () => {
        const urls = [];
        await fetchDeferredPrerequisite({
            fetchFn: async (url) => {
                urls.push(url);
                return { ok: true, json: async () => ({ satisfied: true }) };
            },
        });
        assert.equal(urls[0], '/api/openparlor/prerequisites');
    });
});

describe('normalizeServiceError', () => {
    it('should return fallback for null input', () => {
        assert.equal(normalizeServiceError(null), 'Service unavailable. Please try again.');
    });

    it('should return fallback for undefined input', () => {
        assert.equal(normalizeServiceError(undefined), 'Service unavailable. Please try again.');
    });

    it('should return fallback for non-object, non-string input', () => {
        assert.equal(normalizeServiceError(42), 'Service unavailable. Please try again.');
        assert.equal(normalizeServiceError(true), 'Service unavailable. Please try again.');
    });

    it('should return fallback for object without error field', () => {
        assert.equal(normalizeServiceError({}), 'Service unavailable. Please try again.');
        assert.equal(normalizeServiceError({ message: 'something' }), 'Service unavailable. Please try again.');
    });

    it('should return fallback for object with non-string error', () => {
        assert.equal(normalizeServiceError({ error: 42 }), 'Service unavailable. Please try again.');
        assert.equal(normalizeServiceError({ error: null }), 'Service unavailable. Please try again.');
    });

    it('should pass through a safe error message', () => {
        assert.equal(normalizeServiceError({ error: 'Model not found' }), 'Model not found');
    });

    it('should pass through a safe string input', () => {
        assert.equal(normalizeServiceError('Connection timed out'), 'Connection timed out');
    });

    it('should return fallback when error contains a URL', () => {
        assert.equal(
            normalizeServiceError({ error: 'Connection refused at http://localhost:11434' }),
            'Service unavailable. Please try again.',
        );
        assert.equal(
            normalizeServiceError({ error: 'Failed to reach https://api.openai.com/v1' }),
            'Service unavailable. Please try again.',
        );
    });

    it('should return fallback when error contains a file URL', () => {
        assert.equal(
            normalizeServiceError({ error: 'Cannot load file:///opt/models/llama.gguf' }),
            'Service unavailable. Please try again.',
        );
    });

    it('should return fallback when error contains a filesystem path', () => {
        assert.equal(
            normalizeServiceError({ error: 'Failed to load model from /opt/models/llama-7b.gguf' }),
            'Service unavailable. Please try again.',
        );
        assert.equal(
            normalizeServiceError({ error: 'Permission denied: /etc/shadow' }),
            'Service unavailable. Please try again.',
        );
    });

    it('should return fallback when error contains credential patterns', () => {
        assert.equal(
            normalizeServiceError({ error: 'Invalid api_key: sk-abc123secret' }),
            'Service unavailable. Please try again.',
        );
        assert.equal(
            normalizeServiceError({ error: 'Authorization: Bearer eyJhbGciOi' }),
            'Service unavailable. Please try again.',
        );
        assert.equal(
            normalizeServiceError({ error: 'token=supersecret123' }),
            'Service unavailable. Please try again.',
        );
    });

    it('should use custom fallback when provided', () => {
        assert.equal(
            normalizeServiceError({ error: 'http://internal:8080/secret' }, 'TTS service unavailable'),
            'TTS service unavailable',
        );
        assert.equal(
            normalizeServiceError(null, 'Chat failed'),
            'Chat failed',
        );
    });

    it('should truncate overly long safe messages', () => {
        const longMsg = 'A'.repeat(250);
        const result = normalizeServiceError({ error: longMsg });
        assert.equal(result.length, 200);
        assert.ok(result.endsWith('...'));
    });

    it('should not truncate messages at or under 200 chars', () => {
        const msg = 'B'.repeat(200);
        assert.equal(normalizeServiceError({ error: msg }), msg);
    });

    it('should return fallback for empty or whitespace-only error strings', () => {
        assert.equal(normalizeServiceError({ error: '' }), 'Service unavailable. Please try again.');
        assert.equal(normalizeServiceError({ error: '   ' }), 'Service unavailable. Please try again.');
        assert.equal(normalizeServiceError(''), 'Service unavailable. Please try again.');
    });

    it('should handle error with mixed safe and unsafe content by returning fallback', () => {
        assert.equal(
            normalizeServiceError({ error: 'Error at /var/log/app.log: connection to http://db:5432 failed' }),
            'Service unavailable. Please try again.',
        );
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

describe('normalizeModelStatus', () => {
    it('should normalize valid model status', () => {
        const raw = {
            provider: 'ollama',
            model: 'llama3',
            endpointLabel: 'Local',
            models: ['llama3', 'mistral'],
            connected: true,
        };
        const result = normalizeModelStatus(raw);
        assert.deepEqual(result, {
            provider: 'ollama',
            model: 'llama3',
            endpointLabel: 'Local',
            models: ['llama3', 'mistral'],
            connected: true,
        });
    });

    it('should return safe defaults for null input', () => {
        const result = normalizeModelStatus(null);
        assert.deepEqual(result, { provider: '', model: '', endpointLabel: '', models: [], connected: false });
    });

    it('should return safe defaults for non-object input', () => {
        const result = normalizeModelStatus('string');
        assert.deepEqual(result, { provider: '', model: '', endpointLabel: '', models: [], connected: false });
    });

    it('should handle missing fields with safe defaults', () => {
        const result = normalizeModelStatus({});
        assert.deepEqual(result, { provider: '', model: '', endpointLabel: '', models: [], connected: false });
    });

    it('should not leak endpoint URLs or base URLs', () => {
        const raw = {
            provider: 'openai',
            model: 'gpt-4',
            connected: true,
            endpoint: 'https://api.openai.com/v1',
            base_url: 'http://localhost:11434',
            api_base: 'http://192.168.1.1:8080',
        };
        const result = normalizeModelStatus(raw);
        assert.equal(result.endpoint, undefined);
        assert.equal(result.base_url, undefined);
        assert.equal(result.api_base, undefined);
        assert.equal(result.provider, 'openai');
    });

    it('should not leak credentials or API keys', () => {
        const raw = {
            provider: 'openai',
            model: 'gpt-4',
            connected: true,
            api_key: 'sk-secret-123',
            credentials: { token: 'abc' },
            auth_header: 'Bearer eyJhbGciOi',
        };
        const result = normalizeModelStatus(raw);
        assert.equal(result.api_key, undefined);
        assert.equal(result.credentials, undefined);
        assert.equal(result.auth_header, undefined);
    });

    it('should not leak filesystem paths', () => {
        const raw = {
            provider: 'local',
            model: 'llama',
            connected: true,
            model_path: '/opt/models/llama-7b.gguf',
            config_path: '/etc/app/config.yaml',
        };
        const result = normalizeModelStatus(raw);
        assert.equal(result.model_path, undefined);
        assert.equal(result.config_path, undefined);
    });

    it('should filter non-string entries from models array', () => {
        const result = normalizeModelStatus({
            provider: 'test',
            model: 'm1',
            connected: true,
            models: ['valid', 42, null, 'also-valid', undefined],
        });
        assert.deepEqual(result.models, ['valid', 'also-valid']);
    });

    it('should default connected to false when not explicitly true', () => {
        assert.equal(normalizeModelStatus({ connected: 'yes' }).connected, false);
        assert.equal(normalizeModelStatus({ connected: 1 }).connected, false);
        assert.equal(normalizeModelStatus({ connected: null }).connected, false);
    });

    it('should default endpointLabel to empty string when not a string', () => {
        assert.equal(normalizeModelStatus({ endpointLabel: 42 }).endpointLabel, '');
        assert.equal(normalizeModelStatus({ endpointLabel: null }).endpointLabel, '');
    });
});

describe('normalizeTtsVoices', () => {
    it('should normalize valid TTS voices response', () => {
        const raw = { voices: ['en-US-AriaNeural', 'en-GB-SoniaNeural'], available: true };
        const result = normalizeTtsVoices(raw);
        assert.deepEqual(result, {
            voices: ['en-US-AriaNeural', 'en-GB-SoniaNeural'],
            available: true,
        });
    });

    it('should return safe defaults for null input', () => {
        assert.deepEqual(normalizeTtsVoices(null), { voices: [], available: false });
    });

    it('should return safe defaults for non-object input', () => {
        assert.deepEqual(normalizeTtsVoices('string'), { voices: [], available: false });
        assert.deepEqual(normalizeTtsVoices(42), { voices: [], available: false });
    });

    it('should handle missing fields with safe defaults', () => {
        assert.deepEqual(normalizeTtsVoices({}), { voices: [], available: false });
    });

    it('should filter non-string entries from voices array', () => {
        const result = normalizeTtsVoices({ voices: ['valid', 42, null, 'also-valid'], available: true });
        assert.deepEqual(result.voices, ['valid', 'also-valid']);
    });

    it('should default available to false when not explicitly true', () => {
        assert.equal(normalizeTtsVoices({ voices: ['a'], available: 'yes' }).available, false);
        assert.equal(normalizeTtsVoices({ voices: ['a'], available: 1 }).available, false);
    });

    it('should not leak endpoint URLs or credentials', () => {
        const raw = {
            voices: ['voice-a'],
            available: true,
            endpoint: 'https://tts.example.com/api',
            api_key: 'tts-secret',
            model_path: '/opt/tts/models',
        };
        const result = normalizeTtsVoices(raw);
        assert.equal(result.endpoint, undefined);
        assert.equal(result.api_key, undefined);
        assert.equal(result.model_path, undefined);
        assert.deepEqual(result.voices, ['voice-a']);
    });
});

describe('selectSupportedMime', () => {
    it('should return the first supported MIME type', () => {
        const result = selectSupportedMime(
            ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'],
            (mime) => mime === 'audio/webm',
        );
        assert.equal(result, 'audio/webm');
    });

    it('should return empty string when none are supported', () => {
        const result = selectSupportedMime(
            ['audio/webm', 'audio/ogg'],
            () => false,
        );
        assert.equal(result, '');
    });

    it('should return empty string for empty candidates', () => {
        const result = selectSupportedMime([], () => true);
        assert.equal(result, '');
    });
});

describe('shouldAutoSendTranscription', () => {
    it('should return true when voice mode is enabled and transcription succeeded', () => {
        assert.equal(
            shouldAutoSendTranscription({ voiceModeEnabled: true, transcriptionSucceeded: true }),
            true,
        );
    });

    it('should return false when voice mode is disabled', () => {
        assert.equal(
            shouldAutoSendTranscription({ voiceModeEnabled: false, transcriptionSucceeded: true }),
            false,
        );
    });

    it('should return false when transcription failed', () => {
        assert.equal(
            shouldAutoSendTranscription({ voiceModeEnabled: true, transcriptionSucceeded: false }),
            false,
        );
    });
});

describe('shouldAutoSpeak', () => {
    const baseParams = {
        sendConversationId: 'conv-1',
        currentConversationId: 'conv-1',
        sendEpoch: 1,
        selectionEpoch: 1,
        streamDone: true,
        hadStreamError: false,
        autoSpeakEnabled: true,
        hasContent: true,
        recordingActive: false,
    };

    it('should return true when all conditions are met', () => {
        assert.equal(shouldAutoSpeak(baseParams), true);
    });

    it('should return false when conversation changed', () => {
        assert.equal(shouldAutoSpeak({ ...baseParams, currentConversationId: 'conv-2' }), false);
    });

    it('should return false when epoch mismatch', () => {
        assert.equal(shouldAutoSpeak({ ...baseParams, selectionEpoch: 2 }), false);
    });

    it('should return false when stream not done', () => {
        assert.equal(shouldAutoSpeak({ ...baseParams, streamDone: false }), false);
    });

    it('should return false when stream had error', () => {
        assert.equal(shouldAutoSpeak({ ...baseParams, hadStreamError: true }), false);
    });

    it('should return false when auto-speak disabled', () => {
        assert.equal(shouldAutoSpeak({ ...baseParams, autoSpeakEnabled: false }), false);
    });

    it('should return false when no content', () => {
        assert.equal(shouldAutoSpeak({ ...baseParams, hasContent: false }), false);
    });

    it('should return false when recording is active', () => {
        assert.equal(shouldAutoSpeak({ ...baseParams, recordingActive: true }), false);
    });

    it('should return false when sendConversationId is empty', () => {
        assert.equal(shouldAutoSpeak({ ...baseParams, sendConversationId: '' }), false);
    });
});

describe('createVoiceTurnTimer', () => {
    it('should track phases and report durations', () => {
        let now = 0;
        const timer = createVoiceTurnTimer({ now: () => now });
        timer.start();
        assert.equal(timer.active, true);

        now = 100;
        timer.markRecordingEnd();
        now = 500;
        timer.markSttComplete();
        now = 600;
        timer.markSendStart();
        now = 800;
        timer.markFirstToken();
        now = 2000;
        timer.markStreamComplete();
        now = 2500;
        timer.markTtsReady();

        const report = timer.report();
        assert.equal(report.recordingToStt, 400);
        assert.equal(report.sendToFirstToken, 200);
        assert.equal(report.firstTokenToComplete, 1200);
        assert.equal(report.completeToTts, 500);
        assert.equal(report.totalTurn, 2400);
    });

    it('should return null report when not active', () => {
        const timer = createVoiceTurnTimer({ now: () => 0 });
        assert.equal(timer.report(), null);
    });

    it('should reset on cancel', () => {
        let now = 0;
        const timer = createVoiceTurnTimer({ now: () => now });
        timer.start();
        now = 100;
        timer.markRecordingEnd();
        timer.cancel();
        assert.equal(timer.active, false);
        assert.equal(timer.report(), null);
    });

    it('should only record first token once', () => {
        let now = 0;
        const timer = createVoiceTurnTimer({ now: () => now });
        timer.start();
        now = 100;
        timer.markSendStart();
        now = 200;
        timer.markFirstToken();
        now = 300;
        timer.markFirstToken();
        now = 500;
        timer.markStreamComplete();

        const report = timer.report();
        assert.equal(report.sendToFirstToken, 100);
        assert.equal(report.firstTokenToComplete, 300);
    });

    it('should log via injected logFn', () => {
        const logged = [];
        let now = 0;
        const timer = createVoiceTurnTimer({ now: () => now, logFn: (data) => logged.push(data) });
        timer.start();
        now = 100;
        timer.markRecordingEnd();
        now = 200;
        timer.markSttComplete();
        timer.log();
        assert.equal(logged.length, 1);
        assert.equal(logged[0].recordingToStt, '100ms');
    });
});

describe('createRecorderController', () => {
    function createMockMediaRecorder() {
        const instances = [];
        class MockMediaRecorder {
            constructor(stream, options) {
                this.stream = stream;
                this.options = options;
                this.state = 'inactive';
                this.ondataavailable = null;
                this.onstop = null;
                instances.push(this);
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
            static isTypeSupported(mime) {
                return mime === 'audio/webm;codecs=opus';
            }
        }
        return { Ctor: MockMediaRecorder, instances };
    }

    it('should start recording and produce a blob on stop', async () => {
        const { Ctor, instances } = createMockMediaRecorder();
        const mockStream = { getTracks: () => [{ stop: () => {} }] };
        const states = [];

        const controller = createRecorderController({
            getUserMedia: async () => mockStream,
            MediaRecorderCtor: Ctor,
            onStateChange: (s) => states.push(s),
        });

        assert.equal(controller.state, 'idle');
        await controller.start();
        assert.equal(controller.state, 'recording');

        const recorder = instances[0];
        const chunk = new Blob(['fake-audio-data']);
        recorder.ondataavailable({ data: chunk });

        controller.stop();
        assert.equal(controller.state, 'stopped');
        assert.ok(controller.blob instanceof Blob);
        assert.equal(controller.blob.size, chunk.size);
    });

    it('should report error when MediaRecorder is not supported', async () => {
        const controller = createRecorderController({
            MediaRecorderCtor: null,
        });
        await controller.start();
        assert.equal(controller.state, 'error');
        assert.equal(controller.error, 'MediaRecorder not supported');
    });

    it('should report permission denied', async () => {
        const { Ctor } = createMockMediaRecorder();
        const controller = createRecorderController({
            getUserMedia: async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); },
            MediaRecorderCtor: Ctor,
        });
        await controller.start();
        assert.equal(controller.state, 'error');
        assert.equal(controller.error, 'Permission denied');
    });

    it('should cancel and discard blob', async () => {
        const { Ctor, instances } = createMockMediaRecorder();
        const mockStream = { getTracks: () => [{ stop: () => {} }] };

        const controller = createRecorderController({
            getUserMedia: async () => mockStream,
            MediaRecorderCtor: Ctor,
        });

        await controller.start();
        const recorder = instances[0];
        recorder.ondataavailable({ data: new Blob(['data']) });
        controller.cancel();
        assert.equal(controller.state, 'idle');
        assert.equal(controller.blob, null);
    });

    it('should select supported MIME type', async () => {
        const { Ctor, instances } = createMockMediaRecorder();
        const mockStream = { getTracks: () => [{ stop: () => {} }] };

        const controller = createRecorderController({
            getUserMedia: async () => mockStream,
            MediaRecorderCtor: Ctor,
            mimeCandidates: ['audio/unsupported', 'audio/webm;codecs=opus'],
        });

        await controller.start();
        assert.equal(instances[0].options.mimeType, 'audio/webm;codecs=opus');
    });
});

describe('createTranscriptionController', () => {
    it('should transcribe a blob and return text with CSRF token', async () => {
        const blob = new Blob(['audio-data']);
        const mockResponse = {
            ok: true,
            json: async () => ({ text: 'Hello world' }),
        };
        const fetchCalls = [];

        const controller = createTranscriptionController({
            fetchFn: async (url, opts) => {
                fetchCalls.push({ url, opts });
                return mockResponse;
            },
            getCsrfToken: async () => 'test-token',
        });

        const result = await controller.transcribe(blob);
        assert.equal(result, 'Hello world');
        assert.equal(controller.state, 'ready');
        assert.equal(fetchCalls[0].url, '/api/openparlor/stt/transcribe');
        assert.equal(fetchCalls[0].opts.headers['X-CSRF-Token'], 'test-token');
    });

    it('should return null for empty blob', async () => {
        const controller = createTranscriptionController({
            fetchFn: async () => ({ ok: true, json: async () => ({ text: 'x' }) }),
        });
        const result = await controller.transcribe(new Blob(['']));
        assert.equal(result, null);
    });

    it('should return null and set error on failure', async () => {
        const blob = new Blob(['audio-data']);
        const controller = createTranscriptionController({
            fetchFn: async () => ({ ok: false, json: async () => ({}) }),
        });
        const result = await controller.transcribe(blob);
        assert.equal(result, null);
        assert.equal(controller.state, 'error');
        assert.ok(controller.error.length > 0);
    });

    it('should return null when response has no text', async () => {
        const blob = new Blob(['audio-data']);
        const controller = createTranscriptionController({
            fetchFn: async () => ({ ok: true, json: async () => ({ text: '' }) }),
        });
        const result = await controller.transcribe(blob);
        assert.equal(result, null);
    });

    it('should not call fetch when already busy', async () => {
        let fetchCount = 0;
        const blob = new Blob(['audio-data']);
        const controller = createTranscriptionController({
            fetchFn: async () => {
                fetchCount++;
                return new Promise(() => {});
            },
        });
        void controller.transcribe(blob);
        const p2 = await controller.transcribe(blob);
        assert.equal(p2, null);
        assert.equal(fetchCount, 1);
    });

    it('should reject blobs exceeding maxSizeBytes without calling fetch', async () => {
        let fetchCalled = false;
        const largeBlob = new Blob(['a'.repeat(1024)]);
        const controller = createTranscriptionController({
            fetchFn: async () => {
                fetchCalled = true;
                return { ok: true, json: async () => ({ text: 'x' }) };
            },
            maxSizeBytes: 512,
        });
        const result = await controller.transcribe(largeBlob);
        assert.equal(result, null);
        assert.equal(fetchCalled, false);
        assert.equal(controller.state, 'error');
        assert.ok(controller.error.includes('too large'));
    });

    it('should accept blobs at exactly maxSizeBytes', async () => {
        const exactBlob = new Blob(['a'.repeat(512)]);
        const controller = createTranscriptionController({
            fetchFn: async () => ({ ok: true, json: async () => ({ text: 'ok' }) }),
            maxSizeBytes: 512,
        });
        const result = await controller.transcribe(exactBlob);
        assert.equal(result, 'ok');
    });

    it('should use 5MB default max size', async () => {
        const justUnder = new Blob(['a'.repeat(5 * 1024 * 1024)]);
        const controller = createTranscriptionController({
            fetchFn: async () => ({ ok: true, json: async () => ({ text: 'ok' }) }),
        });
        const result = await controller.transcribe(justUnder);
        assert.equal(result, 'ok');
    });
});

describe('createPlaybackController', () => {
    function createMockAudio(url) {
        const listeners = {};
        return {
            src: url,
            play: async () => {},
            pause: () => {},
            addEventListener: (event, fn) => {
                listeners[event] = fn;
            },
            _fire: (event) => {
                if (listeners[event]) listeners[event]();
            },
        };
    }

    it('should play audio and report isPlaying', async () => {
        const mockAudio = createMockAudio('blob:test');
        const fetchCalls = [];

        const controller = createPlaybackController({
            fetchFn: async (url, opts) => {
                fetchCalls.push({ url, opts });
                return {
                    ok: true,
                    blob: async () => new Blob(['audio']),
                };
            },
            createObjectURL: () => 'blob:test',
            revokeObjectURL: () => {},
            audioFactory: () => mockAudio,
        });

        assert.equal(controller.isPlaying, false);
        const url = await controller.play('Hello', 'voice-a');
        assert.equal(url, 'blob:test');
        assert.equal(controller.isPlaying, true);
        assert.equal(fetchCalls[0].url, '/api/openparlor/tts/synthesize');
    });

    it('should stop playback and revoke URL', async () => {
        let revoked = false;
        const mockAudio = createMockAudio('blob:test');
        let paused = false;
        mockAudio.pause = () => { paused = true; };

        const controller = createPlaybackController({
            fetchFn: async () => ({ ok: true, blob: async () => new Blob(['audio']) }),
            createObjectURL: () => 'blob:test',
            revokeObjectURL: () => { revoked = true; },
            audioFactory: () => mockAudio,
        });

        await controller.play('Hello', 'voice-a');
        controller.stop();
        assert.equal(controller.isPlaying, false);
        assert.equal(paused, true);
        assert.equal(revoked, true);
    });

    it('should throw on synthesis failure with safe error', async () => {
        const controller = createPlaybackController({
            fetchFn: async () => ({
                ok: false,
                json: async () => ({ error: 'TTS engine failed' }),
            }),
            createObjectURL: () => 'blob:test',
            revokeObjectURL: () => {},
            audioFactory: () => createMockAudio('blob:test'),
        });

        await assert.rejects(
            () => controller.play('Hello', 'voice-a'),
            /TTS engine failed/,
        );
    });

    it('should stop previous playback when starting new one', async () => {
        let revoked = 0;
        let audioCount = 0;
        const controller = createPlaybackController({
            fetchFn: async () => ({ ok: true, blob: async () => new Blob(['audio']) }),
            createObjectURL: () => 'blob:test',
            revokeObjectURL: () => { revoked++; },
            audioFactory: () => {
                audioCount++;
                return createMockAudio('blob:test');
            },
        });

        await controller.play('First', 'voice-a');
        await controller.play('Second', 'voice-b');
        assert.equal(revoked, 1);
        assert.equal(audioCount, 2);
    });

    it('should call onEnded when audio ends naturally', async () => {
        const mockAudio = createMockAudio('blob:test');
        let endedCalled = false;

        const controller = createPlaybackController({
            fetchFn: async () => ({ ok: true, blob: async () => new Blob(['audio']) }),
            createObjectURL: () => 'blob:test',
            revokeObjectURL: () => {},
            audioFactory: () => mockAudio,
        });

        controller.onEnded = () => { endedCalled = true; };
        await controller.play('Hello', 'voice-a');
        mockAudio._fire('ended');
        assert.equal(endedCalled, true);
        assert.equal(controller.isPlaying, false);
    });

    it('should send CSRF token with TTS synthesis request when provider is configured', async () => {
        const fetchCalls = [];
        const controller = createPlaybackController({
            fetchFn: async (url, opts) => {
                fetchCalls.push({ url, opts });
                return { ok: true, blob: async () => new Blob(['audio']) };
            },
            createObjectURL: () => 'blob:test',
            revokeObjectURL: () => {},
            audioFactory: () => ({ src: '', play: async () => {}, pause: () => {}, addEventListener: () => {} }),
            getCsrfToken: async () => 'csrf-tts-token',
        });

        await controller.play('Hello', 'voice-a');
        assert.equal(fetchCalls[0].opts.headers['X-CSRF-Token'], 'csrf-tts-token');
    });

    it('should omit CSRF header when no token provider is configured', async () => {
        const fetchCalls = [];
        const controller = createPlaybackController({
            fetchFn: async (url, opts) => {
                fetchCalls.push({ url, opts });
                return { ok: true, blob: async () => new Blob(['audio']) };
            },
            createObjectURL: () => 'blob:test',
            revokeObjectURL: () => {},
            audioFactory: () => ({ src: '', play: async () => {}, pause: () => {}, addEventListener: () => {} }),
        });

        await controller.play('Hello', 'voice-a');
        assert.equal(fetchCalls[0].opts.headers['X-CSRF-Token'], undefined);
    });

    it('should omit CSRF header when token provider returns empty string', async () => {
        const fetchCalls = [];
        const controller = createPlaybackController({
            fetchFn: async (url, opts) => {
                fetchCalls.push({ url, opts });
                return { ok: true, blob: async () => new Blob(['audio']) };
            },
            createObjectURL: () => 'blob:test',
            revokeObjectURL: () => {},
            audioFactory: () => ({ src: '', play: async () => {}, pause: () => {}, addEventListener: () => {} }),
            getCsrfToken: async () => '',
        });

        await controller.play('Hello', 'voice-a');
        assert.equal(fetchCalls[0].opts.headers['X-CSRF-Token'], undefined);
    });
});

describe('server-side provider ownership', () => {
    it('should not expose provider configuration through model status', () => {
        const raw = {
            provider: 'openai',
            model: 'gpt-4',
            endpointLabel: 'OpenAI',
            models: ['gpt-4', 'gpt-4-turbo'],
            connected: true,
            api_key: 'sk-proj-abc123',
            base_url: 'https://api.openai.com/v1',
            organization: 'org-xyz',
            max_tokens: 4096,
            temperature: 0.7,
        };
        const result = normalizeModelStatus(raw);
        assert.deepEqual(Object.keys(result).sort(), ['connected', 'endpointLabel', 'model', 'models', 'provider']);
        assert.equal(result.api_key, undefined);
        assert.equal(result.base_url, undefined);
        assert.equal(result.organization, undefined);
        assert.equal(result.max_tokens, undefined);
        assert.equal(result.temperature, undefined);
    });

    it('should not expose provider configuration through health status', () => {
        const raw = {
            model: {
                available: true,
                label: 'llama3',
                endpoint: 'http://localhost:11434',
                api_key: 'ollama-secret',
                model_path: '/opt/models/llama3.gguf',
                context_length: 4096,
            },
            tts: {
                available: true,
                label: 'Piper',
                model_path: '/opt/tts/piper/en_US-lessac-medium.onnx',
                voice_dir: '/var/tts/voices',
            },
            stt: {
                available: true,
                label: 'Whisper',
                model_path: '/opt/stt/whisper/base.pt',
                device: 'cuda:0',
            },
        };
        const result = normalizeHealthStatus(raw);
        assert.deepEqual(Object.keys(result.model).sort(), ['available', 'label']);
        assert.deepEqual(Object.keys(result.tts).sort(), ['available', 'label']);
        assert.deepEqual(Object.keys(result.stt).sort(), ['available', 'label']);
    });

    it('should not expose provider configuration through settings', () => {
        const raw = {
            model: {
                provider: 'anthropic',
                model: 'claude-3-opus',
                connected: true,
                api_key: 'sk-ant-abc123',
                base_url: 'https://api.anthropic.com',
                max_tokens: 8192,
                system_prompt: 'You are helpful.',
            },
            speech: {
                voicesAvailable: true,
                voiceModeEnabled: false,
                tts_endpoint: 'http://tts-internal:5000',
                stt_endpoint: 'http://stt-internal:5001',
                whisper_model: 'large-v3',
            },
            character: {
                defaultCharacterId: 'char-1',
                count: 5,
                storage_path: '/var/lib/openparlor/characters',
            },
        };
        const result = normalizeSettings(raw);
        assert.deepEqual(Object.keys(result.model).sort(), ['connected', 'model', 'provider']);
        assert.deepEqual(Object.keys(result.speech).sort(), ['voiceModeEnabled', 'voicesAvailable']);
        assert.deepEqual(Object.keys(result.character).sort(), ['count', 'defaultCharacterId']);
    });

    it('should sanitize TTS synthesis errors containing provider URLs', async () => {
        const controller = createPlaybackController({
            fetchFn: async () => ({
                ok: false,
                json: async () => ({ error: 'Connection refused at http://tts-internal:5000/synthesize' }),
            }),
            createObjectURL: () => 'blob:test',
            revokeObjectURL: () => {},
            audioFactory: () => ({ src: '', play: async () => {}, pause: () => {}, addEventListener: () => {} }),
        });

        await assert.rejects(
            () => controller.play('Hello', 'voice-a'),
            (err) => {
                assert.ok(!err.message.includes('http'));
                assert.ok(!err.message.includes('tts-internal'));
                return true;
            },
        );
    });

    it('should sanitize TTS synthesis errors containing filesystem paths', async () => {
        const controller = createPlaybackController({
            fetchFn: async () => ({
                ok: false,
                json: async () => ({ error: 'Model not found at /opt/tts/models/piper/en_US-lessac-medium.onnx' }),
            }),
            createObjectURL: () => 'blob:test',
            revokeObjectURL: () => {},
            audioFactory: () => ({ src: '', play: async () => {}, pause: () => {}, addEventListener: () => {} }),
        });

        await assert.rejects(
            () => controller.play('Hello', 'voice-a'),
            (err) => {
                assert.ok(!err.message.includes('/opt/'));
                assert.ok(!err.message.includes('.onnx'));
                return true;
            },
        );
    });

    it('should sanitize TTS synthesis errors containing credentials', async () => {
        const controller = createPlaybackController({
            fetchFn: async () => ({
                ok: false,
                json: async () => ({ error: 'Unauthorized: api_key=sk-tts-secret-456' }),
            }),
            createObjectURL: () => 'blob:test',
            revokeObjectURL: () => {},
            audioFactory: () => ({ src: '', play: async () => {}, pause: () => {}, addEventListener: () => {} }),
        });

        await assert.rejects(
            () => controller.play('Hello', 'voice-a'),
            (err) => {
                assert.ok(!err.message.includes('sk-tts-secret-456'));
                assert.ok(!err.message.includes('api_key'));
                return true;
            },
        );
    });

    it('should send CSRF token with transcription requests when provider is available', async () => {
        const blob = new Blob(['audio']);
        const fetchCalls = [];
        const controller = createTranscriptionController({
            fetchFn: async (url, opts) => {
                fetchCalls.push({ url, opts });
                return { ok: true, json: async () => ({ text: 'ok' }) };
            },
            getCsrfToken: async () => 'csrf-abc',
        });
        await controller.transcribe(blob);
        assert.equal(fetchCalls[0].opts.headers['X-CSRF-Token'], 'csrf-abc');
    });

    it('should omit CSRF header when no token provider is configured', async () => {
        const blob = new Blob(['audio']);
        const fetchCalls = [];
        const controller = createTranscriptionController({
            fetchFn: async (url, opts) => {
                fetchCalls.push({ url, opts });
                return { ok: true, json: async () => ({ text: 'ok' }) };
            },
        });
        await controller.transcribe(blob);
        assert.equal(fetchCalls[0].opts.headers['X-CSRF-Token'], undefined);
    });

    it('should report missing developer storage state as deferred without leaking paths', () => {
        const raw = {
            satisfied: false,
            label: 'Developer storage state not found at /home/dev/.openparlor/storage-state.json',
        };
        const result = normalizeDeferredPrerequisite(raw);
        assert.equal(result.deferred, true);
        assert.ok(!result.label.includes('/home/dev'));
        assert.ok(!result.label.includes('storage-state.json'));
    });

    it('should report satisfied developer storage state as non-deferred', () => {
        const raw = { satisfied: true, label: 'Storage state found' };
        const result = normalizeDeferredPrerequisite(raw);
        assert.equal(result.deferred, false);
        assert.equal(result.label, '');
    });
});

describe('resolveBrowserUrl', () => {
    it('should resolve a localhost URL as local with guidance', () => {
        const result = resolveBrowserUrl({ origin: 'http://localhost:3000' });
        assert.equal(result.url, 'http://localhost:3000/openparlor');
        assert.equal(result.isLocal, true);
        assert.equal(result.guidance, 'Open http://localhost:3000/openparlor in your browser');
    });

    it('should resolve a 127.0.0.1 URL as local', () => {
        const result = resolveBrowserUrl({ origin: 'http://127.0.0.1:8080' });
        assert.equal(result.url, 'http://127.0.0.1:8080/openparlor');
        assert.equal(result.isLocal, true);
        assert.equal(result.guidance, 'Open http://127.0.0.1:8080/openparlor in your browser');
    });

    it('should resolve a remote URL as non-local with connect guidance', () => {
        const result = resolveBrowserUrl({ origin: 'https://parlor.example.com' });
        assert.equal(result.url, 'https://parlor.example.com/openparlor');
        assert.equal(result.isLocal, false);
        assert.equal(result.guidance, 'Connect to https://parlor.example.com/openparlor');
    });

    it('should strip embedded credentials from the origin', () => {
        const result = resolveBrowserUrl({ origin: 'http://user:pass@localhost:3000' });
        assert.equal(result.url, 'http://localhost:3000/openparlor');
        assert.ok(!result.url.includes('user'));
        assert.ok(!result.url.includes('pass'));
    });

    it('should not leak credentials in guidance', () => {
        const result = resolveBrowserUrl({ origin: 'http://admin:secret@localhost:3000' });
        assert.ok(!result.guidance.includes('admin'));
        assert.ok(!result.guidance.includes('secret'));
    });

    it('should return empty URL and fallback guidance for missing origin', () => {
        const result = resolveBrowserUrl();
        assert.equal(result.url, '');
        assert.equal(result.isLocal, false);
        assert.equal(result.guidance, 'No origin configured');
    });

    it('should return empty URL for non-string origin', () => {
        const result = resolveBrowserUrl({ origin: 42 });
        assert.equal(result.url, '');
        assert.equal(result.isLocal, false);
        assert.equal(result.guidance, 'No origin configured');
    });

    it('should use custom pathname when provided', () => {
        const result = resolveBrowserUrl({ origin: 'http://localhost:3000', pathname: '/custom' });
        assert.equal(result.url, 'http://localhost:3000/custom');
    });

    it('should handle origin with trailing slash', () => {
        const result = resolveBrowserUrl({ origin: 'http://localhost:3000/' });
        assert.equal(result.url, 'http://localhost:3000/openparlor');
        assert.equal(result.isLocal, true);
    });

    it('should not include filesystem paths in the resolved URL', () => {
        const result = resolveBrowserUrl({ origin: 'http://localhost:3000', pathname: '/openparlor' });
        assert.ok(!result.url.includes('/home/'));
        assert.ok(!result.url.includes('/var/'));
        assert.ok(!result.url.includes('/etc/'));
    });

    it('should not treat non-http schemes as local', () => {
        const result = resolveBrowserUrl({ origin: 'ftp://localhost:21' });
        assert.equal(result.isLocal, false);
    });

    it('should handle empty string origin', () => {
        const result = resolveBrowserUrl({ origin: '' });
        assert.equal(result.url, '');
        assert.equal(result.isLocal, false);
        assert.equal(result.guidance, 'No origin configured');
    });
});

describe('HTML/message rendering safety', () => {
    it('should preserve HTML-like content in service errors as plain text for textContent rendering', () => {
        const result = normalizeServiceError({ error: '<script>alert("xss")</script>' });
        assert.equal(result, '<script>alert("xss")</script>');
    });

    it('should preserve HTML tags in safe error messages without alteration', () => {
        const result = normalizeServiceError({ error: '<b>bold</b> and <i>italic</i>' });
        assert.equal(result, '<b>bold</b> and <i>italic</i>');
    });

    it('should return fallback when HTML error contains a URL', () => {
        const result = normalizeServiceError({ error: '<a href="http://evil.com">click</a>' });
        assert.equal(result, 'Service unavailable. Please try again.');
    });

    it('should return fallback when HTML error contains a filesystem path', () => {
        const result = normalizeServiceError({ error: '<div>see /etc/passwd for details</div>' });
        assert.equal(result, 'Service unavailable. Please try again.');
    });

    it('should handle HTML in deferred prerequisite labels with path redaction', () => {
        const result = normalizeDeferredPrerequisite({
            satisfied: false,
            label: 'State missing at <code>/var/lib/app/session</code>',
        });
        assert.equal(result.deferred, true);
        assert.ok(!result.label.includes('/var/lib'));
    });

    it('should produce safe plain-text from NDJSON delta records containing HTML', () => {
        const parser = createNdjsonParser();
        const record = JSON.stringify({ type: 'delta', text: '<script>alert("xss")</script>' });
        parser.feed(new TextEncoder().encode(record + '\n'));
        parser.flush();
        assert.equal(parser.records.length, 1);
        assert.equal(parser.records[0].text, '<script>alert("xss")</script>');
    });

    it('should produce safe plain-text from NDJSON error records containing HTML', () => {
        const parser = createNdjsonParser();
        const record = JSON.stringify({ type: 'error', error: '<img src=x onerror=alert(1)>' });
        parser.feed(new TextEncoder().encode(record + '\n'));
        parser.flush();
        assert.equal(parser.records.length, 1);
        assert.equal(parser.records[0].error, '<img src=x onerror=alert(1)>');
    });

    it('should preserve HTML-like conversation titles as plain strings', () => {
        const result = normalizeConversation({
            id: 'conv-1',
            title: '<script>alert("xss")</script>',
            character_id: 'char-1',
        });
        assert.equal(result.title, '<script>alert("xss")</script>');
    });

    it('should preserve HTML-like character names as plain strings', () => {
        const result = normalizeCharacter({
            id: 'char-1',
            name: '<b>Evil</b> <script>bad()</script>',
        });
        assert.equal(result.name, '<b>Evil</b> <script>bad()</script>');
    });

    it('should preserve HTML-like memory content as plain strings', () => {
        const result = normalizeMemory({
            id: 'mem-1',
            content: '<iframe src="http://evil.com"></iframe>',
        });
        assert.equal(result.content, '<iframe src="http://evil.com"></iframe>');
    });

    it('should preserve HTML-like character names through sanitization as text', () => {
        const result = sanitizeCharacterInput({
            name: '<script>alert(1)</script>',
            avatar_url: '',
            tts_voice: '',
        });
        assert.equal(result.name, '<script>alert(1)</script>');
    });

    it('should strip control characters from HTML-like names but keep visible HTML as text', () => {
        const result = sanitizeCharacterInput({
            name: '<script>\x00alert(1)</script>',
            avatar_url: '',
            tts_voice: '',
        });
        assert.equal(result.name, '<script>alert(1)</script>');
    });

    it('should not allow HTML injection through model status endpoint label', () => {
        const result = normalizeModelStatus({
            provider: 'test',
            model: 'm1',
            endpointLabel: '<script>document.cookie</script>',
            connected: true,
        });
        assert.equal(result.endpointLabel, '<script>document.cookie</script>');
    });

    it('should not allow HTML injection through health status labels', () => {
        const result = normalizeHealthStatus({
            model: { available: true, label: '<b>safe</b>' },
            tts: null,
            stt: null,
        });
        assert.equal(result.model.label, '<b>safe</b>');
    });
});

describe('resolveMessageCharacterId', () => {
    const conversation = {
        id: 'conv-1',
        characterId: 'char-primary',
        participants: [
            { id: 'part-a', characterId: 'char-alpha', role: 'character' },
            { id: 'part-b', characterId: 'char-beta', role: 'character' },
        ],
    };

    it('should prefer explicit live character_id over participant_id', () => {
        const msg = { role: 'assistant', character_id: 'char-beta', participant_id: 'part-a' };
        assert.equal(resolveMessageCharacterId(msg, conversation), 'char-beta');
    });

    it('should resolve persisted participant_id to the correct character (char-alpha)', () => {
        const msg = { role: 'assistant', participant_id: 'part-a' };
        assert.equal(resolveMessageCharacterId(msg, conversation), 'char-alpha');
    });

    it('should resolve persisted participant_id to the correct character (char-beta)', () => {
        const msg = { role: 'assistant', participant_id: 'part-b' };
        assert.equal(resolveMessageCharacterId(msg, conversation), 'char-beta');
    });

    it('should fall back to primary character when participant_id is not found', () => {
        const msg = { role: 'assistant', participant_id: 'part-unknown' };
        assert.equal(resolveMessageCharacterId(msg, conversation), 'char-primary');
    });

    it('should fall back to primary character when message has no identity fields', () => {
        const msg = { role: 'assistant' };
        assert.equal(resolveMessageCharacterId(msg, conversation), 'char-primary');
    });

    it('should return empty string for user messages', () => {
        const msg = { role: 'user', content: 'hello' };
        assert.equal(resolveMessageCharacterId(msg, conversation), '');
    });

    it('should return empty string for null message', () => {
        assert.equal(resolveMessageCharacterId(null, conversation), '');
    });

    it('should return empty string for non-object message', () => {
        assert.equal(resolveMessageCharacterId('text', conversation), '');
    });

    it('should handle null conversation gracefully', () => {
        const msg = { role: 'assistant', participant_id: 'part-a' };
        assert.equal(resolveMessageCharacterId(msg, null), '');
    });

    it('should handle conversation with no participants array', () => {
        const msg = { role: 'assistant', participant_id: 'part-a' };
        assert.equal(resolveMessageCharacterId(msg, { characterId: 'char-primary' }), 'char-primary');
    });
});

describe('backend-future decision', () => {
    it('harness requires CSRF for all mutations without weakening production', async () => {
        const fetchCalls = [];
        const controller = createTranscriptionController({
            fetchFn: async (url, opts) => {
                fetchCalls.push({ url, opts });
                return { ok: true, json: async () => ({ text: 'ok' }) };
            },
            getCsrfToken: async () => 'production-token',
        });
        await controller.transcribe(new Blob(['audio']));
        assert.equal(fetchCalls[0].opts.headers['X-CSRF-Token'], 'production-token');
    });

    it('missing developer storage state is deferred, not fatal', () => {
        const result = checkLocalReadiness({
            modelStatus: { provider: 'ollama', model: 'llama3', endpointLabel: 'Local', models: ['llama3'], connected: true },
            healthStatus: { model: { available: true, label: 'llama3' }, tts: { available: true, label: 'Piper' }, stt: { available: true, label: 'Whisper' } },
            prerequisite: null,
        });
        assert.equal(result.ready, false);
        assert.equal(result.prerequisite.deferred, true);
        assert.ok(result.blockers.includes('Prerequisite not met'));
    });

    it('configuration discovery exposes only safe fields', () => {
        const model = normalizeModelStatus({
            provider: 'ollama', model: 'llama3', endpointLabel: 'Local',
            models: ['llama3'], connected: true,
            api_key: 'secret', base_url: 'http://localhost:11434',
        });
        assert.deepEqual(Object.keys(model).sort(), ['connected', 'endpointLabel', 'model', 'models', 'provider']);

        const health = normalizeHealthStatus({
            model: { available: true, label: 'llama3', endpoint: 'http://localhost:11434' },
            tts: { available: true, label: 'Piper', model_path: '/opt/piper' },
            stt: { available: true, label: 'Whisper', file_path: '/opt/whisper' },
        });
        assert.deepEqual(Object.keys(health.model).sort(), ['available', 'label']);
        assert.deepEqual(Object.keys(health.tts).sort(), ['available', 'label']);
        assert.deepEqual(Object.keys(health.stt).sort(), ['available', 'label']);
    });
});
