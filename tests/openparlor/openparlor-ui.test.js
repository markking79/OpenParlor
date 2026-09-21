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
        };
        assert.deepEqual(normalizeCharacter(raw), {
            id: 'c1',
            name: 'Emma',
            avatarUrl: '/avatars/emma.png',
        });
    });

    test('provides defaults for missing fields', () => {
        const result = normalizeCharacter({});
        assert.equal(result.id, '');
        assert.equal(result.name, 'Unknown');
        assert.equal(result.avatarUrl, '');
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
        assert.deepEqual(sanitizeCharacterInput(null), { name: '', avatarUrl: '' });
    });

    test('returns empty strings for non-object input', () => {
        assert.deepEqual(sanitizeCharacterInput(42), { name: '', avatarUrl: '' });
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
});
