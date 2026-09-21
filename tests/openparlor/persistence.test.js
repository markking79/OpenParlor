import { describe, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
    ensureOpenParlorDirs,
    getOpenParlorRoot,
    createCharacter,
    getCharacter,
    listCharacters,
    updateCharacter,
    deleteCharacter,
    createConversation,
    getConversation,
    listConversations,
    updateConversation,
    deleteConversation,
    appendMessage,
    getMessages,
    createMemory,
    getMemory,
    listMemories,
    updateMemory,
    deleteMemory,
    getSettings,
    saveSettings,
} from '../../src/openparlor/persistence.js';

/**
 * Creates a temporary directory structure mimicking a user's directory list.
 * @returns {{ root: string, cleanup: () => void }}
 */
function makeTempDirs() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openparlor-test-'));
    return {
        root,
        cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    };
}

describe('OpenParlor persistence', () => {
    /** @type {{ root: string, cleanup: () => void }} */
    let tmp;
    /** @type {{ root: string }} */
    let dirs;

    beforeEach(() => {
        tmp = makeTempDirs();
        dirs = { root: tmp.root };
        ensureOpenParlorDirs(dirs);
    });

    afterEach(() => {
        if (tmp) tmp.cleanup();
    });

    // ─── Ownership filtering ───────────────────────────────────────────────

    describe('ownership filtering', () => {
        it('listCharacters returns only records for the given owner', () => {
            createCharacter(dirs, 'alice', { name: 'A1' });
            createCharacter(dirs, 'alice', { name: 'A2' });
            createCharacter(dirs, 'bob', { name: 'B1' });

            const aliceChars = listCharacters(dirs, 'alice');
            assert.equal(aliceChars.length, 2);
            assert.ok(aliceChars.every(c => c.owner_id === 'alice'));

            const bobChars = listCharacters(dirs, 'bob');
            assert.equal(bobChars.length, 1);
            assert.equal(bobChars[0].name, 'B1');
        });

        it('listConversations returns only non-archived records for the given owner', () => {
            createCharacter(dirs, 'alice', { name: 'C1' });
            const char = listCharacters(dirs, 'alice')[0];

            createConversation(dirs, 'alice', char.id, 'Conv A');
            createConversation(dirs, 'bob', char.id, 'Conv B');

            const aliceConvs = listConversations(dirs, 'alice');
            assert.equal(aliceConvs.length, 1);
            assert.equal(aliceConvs[0].title, 'Conv A');
        });

        it('listMemories returns only records for the given owner and optional character', () => {
            createCharacter(dirs, 'alice', { name: 'C1' });
            const chars = listCharacters(dirs, 'alice');
            const charId = chars[0].id;

            createMemory(dirs, 'alice', { character_id: charId, content: 'm1', known_by_character_ids: [charId] });
            createMemory(dirs, 'alice', { character_id: charId, content: 'm2', known_by_character_ids: [charId] });
            createMemory(dirs, 'bob', { character_id: charId, content: 'm3', known_by_character_ids: [charId] });

            const aliceMems = listMemories(dirs, 'alice');
            assert.equal(aliceMems.length, 2);

            const filtered = listMemories(dirs, 'alice', charId);
            assert.equal(filtered.length, 2);
            assert.ok(filtered.every(m => m.known_by_character_ids.includes(charId)));
        });
    });

    // ─── Round trips ───────────────────────────────────────────────────────

    describe('round trips', () => {
        it('character: create → get → update → get → delete → get null', () => {
            const created = createCharacter(dirs, 'alice', {
                name: 'Test',
                description: 'D',
                system_prompt: 'Stay kind.',
                example_dialogue: 'User: Hello',
                tags: ['friendly', 42],
                tts_provider: 'kokoro',
                tts_voice: 'af_heart',
            });
            assert.ok(created.id);
            assert.equal(created.name, 'Test');
            assert.equal(created.owner_id, 'alice');
            assert.equal(created.system_prompt, 'Stay kind.');
            assert.equal(created.example_dialogue, 'User: Hello');
            assert.deepEqual(created.tags, ['friendly']);
            assert.equal(created.tts_provider, 'kokoro');
            assert.equal(created.tts_voice, 'af_heart');

            const fetched = getCharacter(dirs, created.id);
            assert.deepEqual(fetched, created);

            const updated = updateCharacter(dirs, created.id, { name: 'Updated' });
            assert.equal(updated.name, 'Updated');
            assert.equal(updated.id, created.id);
            assert.equal(updateCharacter(dirs, created.id, { owner_id: 'bob' }).owner_id, 'alice');
            assert.equal(updated.created_at, created.created_at);
            assert.notEqual(updated.updated_at, created.updated_at);
            assert.deepEqual(updateCharacter(dirs, created.id, { tags: ['updated', 1] }).tags, ['updated']);

            assert.equal(deleteCharacter(dirs, created.id), true);
            assert.equal(getCharacter(dirs, created.id), null);
        });

        it('normalizes legacy character records without rewriting them', () => {
            const legacyId = 'legacy-character';
            const legacy = {
                id: legacyId,
                name: 'Legacy',
                description: '',
                personality: '',
                scenario: '',
                first_message: '',
                owner_id: 'alice',
                created_at: '2026-01-01T00:00:00.000Z',
                updated_at: '2026-01-01T00:00:00.000Z',
            };
            const characterPath = path.join(getOpenParlorRoot(dirs), 'characters', `${legacyId}.json`);
            fs.writeFileSync(characterPath, JSON.stringify(legacy));

            const loaded = getCharacter(dirs, legacyId);
            assert.deepEqual(loaded.tags, []);
            assert.equal(loaded.system_prompt, '');
            assert.equal(loaded.example_dialogue, '');
            assert.equal(loaded.tts_provider, '');
            assert.equal(loaded.tts_voice, '');
            assert.deepEqual(JSON.parse(fs.readFileSync(characterPath, 'utf8')), legacy);
        });

        it('conversation: create → get → update → delete → get null', () => {
            const char = createCharacter(dirs, 'alice', { name: 'C' });
            const created = createConversation(dirs, 'alice', char.id, 'My Conv');
            assert.ok(created.id);
            assert.equal(created.title, 'My Conv');
            assert.ok(created.participants.length >= 1);

            const fetched = getConversation(dirs, created.id);
            assert.deepEqual(fetched, created);

            const updated = updateConversation(dirs, created.id, { title: 'Renamed' });
            assert.equal(updated.title, 'Renamed');
            assert.equal(updateConversation(dirs, created.id, { owner_id: 'bob' }).owner_id, 'alice');

            assert.equal(deleteConversation(dirs, created.id), true);
            assert.equal(getConversation(dirs, created.id), null);
        });

        it('memory: create → get → update → delete → get null', () => {
            const char = createCharacter(dirs, 'alice', { name: 'C' });
            const created = createMemory(dirs, 'alice', {
                character_id: char.id,
                content: 'fact',
                importance: 0.9,
                type: 'fact',
                confidence: 0.8,
                known_by_character_ids: [char.id],
            });
            assert.ok(created.id);
            assert.equal(created.content, 'fact');
            assert.equal(created.type, 'fact');
            assert.equal(created.importance, 0.9);
            assert.equal(created.confidence, 0.8);
            assert.equal(created.active, true);
            assert.deepEqual(created.known_by_character_ids, [char.id]);

            const fetched = getMemory(dirs, created.id);
            assert.deepEqual(fetched, created);

            const updated = updateMemory(dirs, created.id, { content: 'updated fact' });
            assert.equal(updated.content, 'updated fact');
            assert.equal(updateMemory(dirs, created.id, { owner_id: 'bob' }).owner_id, 'alice');

            assert.equal(deleteMemory(dirs, created.id), true);
            assert.equal(getMemory(dirs, created.id), null);
        });

        it('settings: save → get round trip', () => {
            const saved = saveSettings(dirs, 'alice', { default_model: 'gpt-4', temperature: 0.7 });
            assert.equal(saved.default_model, 'gpt-4');
            assert.equal(saved.temperature, 0.7);
            assert.equal(saved.owner_id, 'alice');

            const fetched = getSettings(dirs, 'alice');
            assert.equal(fetched.default_model, 'gpt-4');
            assert.equal(fetched.temperature, 0.7);
        });
    });

    // ─── Recency order ─────────────────────────────────────────────────────

    describe('recency order', () => {
        it('listConversations returns most recently updated first', async () => {
            const char = createCharacter(dirs, 'alice', { name: 'C' });

            const conv1 = createConversation(dirs, 'alice', char.id, 'Old');
            // Simulate time passing
            await new Promise(r => setTimeout(r, 10));
            const conv2 = createConversation(dirs, 'alice', char.id, 'New');

            const convs = listConversations(dirs, 'alice');
            assert.equal(convs.length, 2);
            assert.equal(convs[0].id, conv2.id);
            assert.equal(convs[1].id, conv1.id);
        });

        it('updating a conversation moves it to the top', async () => {
            const char = createCharacter(dirs, 'alice', { name: 'C' });
            const conv1 = createConversation(dirs, 'alice', char.id, 'First');
            await new Promise(r => setTimeout(r, 10));
            const conv2 = createConversation(dirs, 'alice', char.id, 'Second');

            // Update conv1 so it becomes most recent
            await new Promise(r => setTimeout(r, 10));
            updateConversation(dirs, conv1.id, { title: 'First Updated' });

            const convs = listConversations(dirs, 'alice');
            assert.equal(convs[0].id, conv1.id);
            assert.equal(convs[1].id, conv2.id);
        });
    });

    // ─── Corrupt trailing JSONL recovery ───────────────────────────────────

    describe('corrupt trailing JSONL recovery', () => {
        it('getMessages skips a trailing incomplete JSON line', () => {
            const char = createCharacter(dirs, 'alice', { name: 'C' });
            const conv = createConversation(dirs, 'alice', char.id, 'Conv');
            const participant = conv.participants[0];

            appendMessage(dirs, conv.id, participant.id, 'hello', 'user');
            appendMessage(dirs, conv.id, participant.id, 'world', 'character');

            // Simulate a crash: append a partial/corrupt line
            const msgPath = path.join(getOpenParlorRoot(dirs), 'conversations', conv.id, 'messages.jsonl');
            fs.appendFileSync(msgPath, '{"id":"corrupt","convers');

            const messages = getMessages(dirs, conv.id);
            assert.equal(messages.length, 2);
            assert.equal(messages[0].content, 'hello');
            assert.equal(messages[1].content, 'world');
        });

        it('getMessages returns empty array for missing file', () => {
            const messages = getMessages(dirs, 'nonexistent-id');
            assert.deepEqual(messages, []);
        });
    });

    // ─── Malformed JSON tolerance in list operations ───────────────────────

    describe('malformed JSON tolerance', () => {
        it('listCharacters skips a corrupt JSON file', () => {
            createCharacter(dirs, 'alice', { name: 'Valid' });
            // Write a corrupt file into the characters directory
            const charDir = path.join(getOpenParlorRoot(dirs), 'characters');
            fs.writeFileSync(path.join(charDir, 'corrupt.json'), '{not valid json');

            const chars = listCharacters(dirs, 'alice');
            assert.equal(chars.length, 1);
            assert.equal(chars[0].name, 'Valid');
        });

        it('listConversations skips a corrupt JSON file', () => {
            const char = createCharacter(dirs, 'alice', { name: 'C' });
            createConversation(dirs, 'alice', char.id, 'Valid');
            const convDir = path.join(getOpenParlorRoot(dirs), 'conversations');
            fs.writeFileSync(path.join(convDir, 'corrupt.json'), 'garbage');

            const convs = listConversations(dirs, 'alice');
            assert.equal(convs.length, 1);
            assert.equal(convs[0].title, 'Valid');
        });

        it('listMemories skips a corrupt JSON file', () => {
            const char = createCharacter(dirs, 'alice', { name: 'C' });
            createMemory(dirs, 'alice', { character_id: char.id, content: 'ok' });
            const memDir = path.join(getOpenParlorRoot(dirs), 'memories');
            fs.writeFileSync(path.join(memDir, 'corrupt.json'), '[[[');

            const mems = listMemories(dirs, 'alice');
            assert.equal(mems.length, 1);
            assert.equal(mems[0].content, 'ok');
        });
    });

    // ─── Path containment ──────────────────────────────────────────────────

    describe('path containment', () => {
        it('getOpenParlorRoot resolves within the user root', () => {
            const root = getOpenParlorRoot(dirs);
            assert.ok(root.startsWith(tmp.root));
            assert.ok(root.endsWith(path.join('openparlor')));
        });
    });

    // ─── Memory schema defaults ────────────────────────────────────────────

    describe('memory schema defaults', () => {
        it('new memory has all required fields with correct defaults', () => {
            const char = createCharacter(dirs, 'alice', { name: 'C' });
            const mem = createMemory(dirs, 'alice', { character_id: char.id, content: 'test' });

            assert.ok(mem.id);
            assert.equal(mem.character_id, char.id);
            assert.equal(mem.conversation_id, null);
            assert.equal(mem.content, 'test');
            assert.equal(mem.type, 'other');
            assert.equal(mem.importance, 0.5);
            assert.equal(mem.confidence, 0.5);
            assert.equal(mem.active, true);
            assert.equal(mem.superseded_by, null);
            assert.equal(mem.source_conversation_id, null);
            assert.equal(mem.source_message_id, null);
            assert.deepEqual(mem.known_by_character_ids, []);
            assert.equal(mem.owner_id, 'alice');
            assert.ok(mem.created_at);
            assert.ok(mem.updated_at);
        });

        it('new memory accepts explicit values for all fields', () => {
            const char = createCharacter(dirs, 'alice', { name: 'C' });
            const otherChar = createCharacter(dirs, 'alice', { name: 'D' });
            const mem = createMemory(dirs, 'alice', {
                character_id: char.id,
                conversation_id: 'conv-123',
                content: 'She likes tea',
                type: 'preference',
                importance: 0.9,
                confidence: 0.7,
                active: false,
                superseded_by: 'mem-456',
                source_conversation_id: 'conv-123',
                source_message_id: 'msg-789',
                known_by_character_ids: [char.id, otherChar.id],
            });

            assert.equal(mem.conversation_id, 'conv-123');
            assert.equal(mem.type, 'preference');
            assert.equal(mem.importance, 0.9);
            assert.equal(mem.confidence, 0.7);
            assert.equal(mem.active, false);
            assert.equal(mem.superseded_by, 'mem-456');
            assert.equal(mem.source_conversation_id, 'conv-123');
            assert.equal(mem.source_message_id, 'msg-789');
            assert.deepEqual(mem.known_by_character_ids, [char.id, otherChar.id]);
        });
    });

    // ─── Memory normalization ──────────────────────────────────────────────

    describe('memory normalization', () => {
        it('clamps importance and confidence to [0, 1]', () => {
            const char = createCharacter(dirs, 'alice', { name: 'C' });
            const mem = createMemory(dirs, 'alice', {
                character_id: char.id,
                content: 'test',
                importance: 1.5,
                confidence: -0.3,
            });
            assert.equal(mem.importance, 1);
            assert.equal(mem.confidence, 0);
        });

        it('defaults unsupported types to "other"', () => {
            const char = createCharacter(dirs, 'alice', { name: 'C' });
            const mem = createMemory(dirs, 'alice', {
                character_id: char.id,
                content: 'test',
                type: 42,
            });
            assert.equal(mem.type, 'other');

            const unsupported = createMemory(dirs, 'alice', {
                character_id: char.id,
                content: 'test',
                type: 'untrusted-type',
            });
            assert.equal(unsupported.type, 'other');
        });

        it('filters non-string entries from known_by_character_ids', () => {
            const char = createCharacter(dirs, 'alice', { name: 'C' });
            const mem = createMemory(dirs, 'alice', {
                character_id: char.id,
                content: 'test',
                known_by_character_ids: [char.id, 123, null, 'valid-id'],
            });
            assert.deepEqual(mem.known_by_character_ids, [char.id, 'valid-id']);
        });

        it('defaults active to true when not a boolean', () => {
            const char = createCharacter(dirs, 'alice', { name: 'C' });
            const mem = createMemory(dirs, 'alice', {
                character_id: char.id,
                content: 'test',
                active: 'yes',
            });
            assert.equal(mem.active, true);
        });
    });

    // ─── Memory provenance ─────────────────────────────────────────────────

    describe('memory provenance', () => {
        it('stores and retrieves source conversation and message ids', () => {
            const char = createCharacter(dirs, 'alice', { name: 'C' });
            const conv = createConversation(dirs, 'alice', char.id, 'Conv');
            const participant = conv.participants[0];
            const msg = appendMessage(dirs, conv.id, participant.id, 'I love jazz', 'user');

            const mem = createMemory(dirs, 'alice', {
                character_id: char.id,
                content: 'User loves jazz',
                type: 'preference',
                source_conversation_id: conv.id,
                source_message_id: msg.id,
                known_by_character_ids: [char.id],
            });

            const fetched = getMemory(dirs, mem.id);
            assert.equal(fetched.source_conversation_id, conv.id);
            assert.equal(fetched.source_message_id, msg.id);
        });

        it('defaults provenance fields to null when not provided', () => {
            const char = createCharacter(dirs, 'alice', { name: 'C' });
            const mem = createMemory(dirs, 'alice', { character_id: char.id, content: 'no source' });
            assert.equal(mem.source_conversation_id, null);
            assert.equal(mem.source_message_id, null);
        });
    });

    // ─── Memory visibility ─────────────────────────────────────────────────

    describe('memory visibility', () => {
        it('listMemories with character_id filters by known_by_character_ids', () => {
            const charA = createCharacter(dirs, 'alice', { name: 'A' });
            const charB = createCharacter(dirs, 'alice', { name: 'B' });

            createMemory(dirs, 'alice', {
                character_id: charA.id,
                content: 'known to A only',
                known_by_character_ids: [charA.id],
            });
            createMemory(dirs, 'alice', {
                character_id: charA.id,
                content: 'known to both',
                known_by_character_ids: [charA.id, charB.id],
            });
            createMemory(dirs, 'alice', {
                character_id: charB.id,
                content: 'known to B only',
                known_by_character_ids: [charB.id],
            });

            const visibleToA = listMemories(dirs, 'alice', charA.id);
            assert.equal(visibleToA.length, 2);
            assert.ok(visibleToA.every(m => m.known_by_character_ids.includes(charA.id)));

            const visibleToB = listMemories(dirs, 'alice', charB.id);
            assert.equal(visibleToB.length, 2);
            assert.ok(visibleToB.every(m => m.known_by_character_ids.includes(charB.id)));
        });

        it('listMemories without character_id returns all owner memories', () => {
            const charA = createCharacter(dirs, 'alice', { name: 'A' });
            createMemory(dirs, 'alice', { character_id: charA.id, content: 'm1', known_by_character_ids: [charA.id] });
            createMemory(dirs, 'alice', { character_id: charA.id, content: 'm2', known_by_character_ids: [] });

            const all = listMemories(dirs, 'alice');
            assert.equal(all.length, 2);
        });

        it('listMemories returns deterministic order (created_at desc, id asc)', async () => {
            const char = createCharacter(dirs, 'alice', { name: 'C' });
            const m1 = createMemory(dirs, 'alice', { character_id: char.id, content: 'first', known_by_character_ids: [char.id] });
            await new Promise(r => setTimeout(r, 10));
            const m2 = createMemory(dirs, 'alice', { character_id: char.id, content: 'second', known_by_character_ids: [char.id] });

            const mems = listMemories(dirs, 'alice', char.id);
            assert.equal(mems.length, 2);
            assert.equal(mems[0].id, m2.id);
            assert.equal(mems[1].id, m1.id);
        });
    });

    // ─── Memory ownership isolation ────────────────────────────────────────

    describe('memory ownership isolation', () => {
        it('memories are not visible across owners even with same character', () => {
            const char = createCharacter(dirs, 'alice', { name: 'C' });
            createMemory(dirs, 'alice', { character_id: char.id, content: 'alice mem', known_by_character_ids: [char.id] });
            createMemory(dirs, 'bob', { character_id: char.id, content: 'bob mem', known_by_character_ids: [char.id] });

            const aliceMems = listMemories(dirs, 'alice', char.id);
            assert.equal(aliceMems.length, 1);
            assert.equal(aliceMems[0].content, 'alice mem');

            const bobMems = listMemories(dirs, 'bob', char.id);
            assert.equal(bobMems.length, 1);
            assert.equal(bobMems[0].content, 'bob mem');
        });
    });

    // ─── Memory updates ────────────────────────────────────────────────────

    describe('memory updates', () => {
        it('updateMemory protects immutable fields (id, owner_id, created_at)', () => {
            const char = createCharacter(dirs, 'alice', { name: 'C' });
            const mem = createMemory(dirs, 'alice', { character_id: char.id, content: 'original' });

            const updated = updateMemory(dirs, mem.id, {
                id: 'hacked-id',
                owner_id: 'bob',
                created_at: '2000-01-01T00:00:00.000Z',
                content: 'modified',
            });
            assert.equal(updated.id, mem.id);
            assert.equal(updated.owner_id, 'alice');
            assert.equal(updated.created_at, mem.created_at);
            assert.equal(updated.content, 'modified');
        });

        it('updateMemory allows updating mutable fields', () => {
            const char = createCharacter(dirs, 'alice', { name: 'C' });
            const mem = createMemory(dirs, 'alice', { character_id: char.id, content: 'old', importance: 0.3 });

            const updated = updateMemory(dirs, mem.id, {
                content: 'new',
                importance: 0.9,
                confidence: 0.6,
                active: false,
                superseded_by: 'other-mem-id',
                known_by_character_ids: [char.id],
            });
            assert.equal(updated.content, 'new');
            assert.equal(updated.importance, 0.9);
            assert.equal(updated.confidence, 0.6);
            assert.equal(updated.active, false);
            assert.equal(updated.superseded_by, 'other-mem-id');
            assert.deepEqual(updated.known_by_character_ids, [char.id]);
            assert.notEqual(updated.updated_at, mem.updated_at);
        });

        it('updateMemory clamps out-of-range values', () => {
            const char = createCharacter(dirs, 'alice', { name: 'C' });
            const mem = createMemory(dirs, 'alice', { character_id: char.id, content: 'test' });

            const updated = updateMemory(dirs, mem.id, { importance: 5, confidence: -2 });
            assert.equal(updated.importance, 1);
            assert.equal(updated.confidence, 0);
        });
    });

    // ─── Memory legacy records ─────────────────────────────────────────────

    describe('memory legacy records', () => {
        it('reads a legacy memory record without new fields using safe defaults', () => {
            const legacyId = 'legacy-mem-001';
            const legacy = {
                id: legacyId,
                character_id: 'char-1',
                conversation_id: null,
                content: 'legacy fact',
                importance: 0.7,
                owner_id: 'alice',
                created_at: '2026-01-01T00:00:00.000Z',
                updated_at: '2026-01-01T00:00:00.000Z',
            };
            const memPath = path.join(getOpenParlorRoot(dirs), 'memories', `${legacyId}.json`);
            fs.writeFileSync(memPath, JSON.stringify(legacy));

            const loaded = getMemory(dirs, legacyId);
            assert.equal(loaded.content, 'legacy fact');
            assert.equal(loaded.type, 'other');
            assert.equal(loaded.confidence, 0.5);
            assert.equal(loaded.active, true);
            assert.equal(loaded.superseded_by, null);
            assert.equal(loaded.source_conversation_id, null);
            assert.equal(loaded.source_message_id, null);
            assert.deepEqual(loaded.known_by_character_ids, ['char-1']);
            assert.equal(loaded.importance, 0.7);

            // File on disk is unchanged (no forced migration write)
            assert.deepEqual(JSON.parse(fs.readFileSync(memPath, 'utf8')), legacy);
        });

        it('legacy memory with out-of-range importance is clamped on read', () => {
            const legacyId = 'legacy-mem-002';
            const legacy = {
                id: legacyId,
                character_id: 'char-1',
                conversation_id: null,
                content: 'bad importance',
                importance: 3.5,
                owner_id: 'alice',
                created_at: '2026-01-01T00:00:00.000Z',
                updated_at: '2026-01-01T00:00:00.000Z',
            };
            const memPath = path.join(getOpenParlorRoot(dirs), 'memories', `${legacyId}.json`);
            fs.writeFileSync(memPath, JSON.stringify(legacy));

            const loaded = getMemory(dirs, legacyId);
            assert.equal(loaded.importance, 1);
        });

        it('listMemories skips corrupt memory files', () => {
            const char = createCharacter(dirs, 'alice', { name: 'C' });
            createMemory(dirs, 'alice', { character_id: char.id, content: 'valid', known_by_character_ids: [char.id] });
            const memDir = path.join(getOpenParlorRoot(dirs), 'memories');
            fs.writeFileSync(path.join(memDir, 'corrupt.json'), 'not json at all');

            const mems = listMemories(dirs, 'alice');
            assert.equal(mems.length, 1);
            assert.equal(mems[0].content, 'valid');
        });

        it('listMemories skips records missing required identity fields', () => {
            const char = createCharacter(dirs, 'alice', { name: 'C' });
            createMemory(dirs, 'alice', { character_id: char.id, content: 'valid', known_by_character_ids: [char.id] });
            const memDir = path.join(getOpenParlorRoot(dirs), 'memories');
            // Record missing owner_id and created_at
            fs.writeFileSync(path.join(memDir, 'invalid.json'), JSON.stringify({ id: 'x', content: 'no owner' }));

            const mems = listMemories(dirs, 'alice');
            assert.equal(mems.length, 1);
            assert.equal(mems[0].content, 'valid');
        });
    });
});
