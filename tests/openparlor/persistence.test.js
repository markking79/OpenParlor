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

            createMemory(dirs, 'alice', { character_id: charId, content: 'm1' });
            createMemory(dirs, 'alice', { character_id: charId, content: 'm2' });
            createMemory(dirs, 'bob', { character_id: charId, content: 'm3' });

            const aliceMems = listMemories(dirs, 'alice');
            assert.equal(aliceMems.length, 2);

            const filtered = listMemories(dirs, 'alice', charId);
            assert.equal(filtered.length, 2);
            assert.ok(filtered.every(m => m.character_id === charId));
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
            const created = createMemory(dirs, 'alice', { character_id: char.id, content: 'fact', importance: 0.9 });
            assert.ok(created.id);
            assert.equal(created.content, 'fact');

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
});
