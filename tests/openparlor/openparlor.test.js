import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeMemory,
    normalizeMemorySource,
    validateMemoryForm,
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
