import assert from 'node:assert/strict';
import test from 'node:test';
import { selectSpeaker } from '../../src/openparlor/speaker-director.js';

function makeParticipants(names) {
    return names.map((name, i) => ({
        id: `part-${i}`,
        character_id: `char-${i}`,
        role: 'character',
    }));
}

function makeCharacters(names) {
    return names.map((name, i) => ({
        id: `char-${i}`,
        name,
    }));
}

test('selects the single character in a one-on-one conversation', () => {
    const participants = makeParticipants(['Alice']);
    const characters = makeCharacters(['Alice']);
    const result = selectSpeaker(participants, characters, 'hello there');
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'part-0');
});

test('selects the mentioned character by name (case-insensitive)', () => {
    const participants = makeParticipants(['Alice', 'Bob', 'Charlie']);
    const characters = makeCharacters(['Alice', 'Bob', 'Charlie']);
    const result = selectSpeaker(participants, characters, 'Hey BOB, what do you think?');
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'part-1');
});

test('selects multiple characters when multiple are mentioned', () => {
    const participants = makeParticipants(['Alice', 'Bob', 'Charlie']);
    const characters = makeCharacters(['Alice', 'Bob', 'Charlie']);
    const result = selectSpeaker(participants, characters, 'Alice and Bob, what do you think?');
    assert.equal(result.length, 2);
    assert.deepEqual(result.map(p => p.id), ['part-0', 'part-1']);
});

test('selects the first character deterministically when no name is mentioned', () => {
    const participants = makeParticipants(['Alice', 'Bob', 'Charlie']);
    const characters = makeCharacters(['Alice', 'Bob', 'Charlie']);
    const result = selectSpeaker(participants, characters, 'what should we do?');
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'part-0');
});

test('does not match partial names (word boundary)', () => {
    const participants = makeParticipants(['Alice', 'Alicia']);
    const characters = makeCharacters(['Alice', 'Alicia']);
    const result = selectSpeaker(participants, characters, 'What does Alicia think?');
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'part-1');
});

test('does not match a name embedded in a longer word', () => {
    const participants = makeParticipants(['Bob', 'Bobby']);
    const characters = makeCharacters(['Bob', 'Bobby']);
    const result = selectSpeaker(participants, characters, 'What does Bobby think?');
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'part-1');
});

test('handles names with special regex characters', () => {
    const participants = makeParticipants(["O'Brien", 'Smith']);
    const characters = makeCharacters(["O'Brien", 'Smith']);
    const result = selectSpeaker(participants, characters, "Hey O'Brien, what's up?");
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'part-0');
});

test('returns empty array when no character participants exist', () => {
    const participants = [{ id: 'p1', character_id: 'c1', role: 'user' }];
    const characters = [];
    const result = selectSpeaker(participants, characters, 'hello');
    assert.equal(result.length, 0);
});

test('returns no speaker for an empty user turn', () => {
    const participants = makeParticipants(['Alice']);
    const characters = makeCharacters(['Alice']);
    assert.deepEqual(selectSpeaker(participants, characters, '   '), []);
});

test('is deterministic: same input always produces same output', () => {
    const participants = makeParticipants(['Alice', 'Bob', 'Charlie']);
    const characters = makeCharacters(['Alice', 'Bob', 'Charlie']);
    const msg = 'tell me about your day';
    const results = new Set();
    for (let i = 0; i < 10; i++) {
        const result = selectSpeaker(participants, characters, msg);
        results.add(result.map(p => p.id).join(','));
    }
    assert.equal(results.size, 1);
});

test('ignores non-character participants in selection', () => {
    const participants = [
        { id: 'user-1', character_id: null, role: 'user' },
        { id: 'part-0', character_id: 'char-0', role: 'character' },
        { id: 'part-1', character_id: 'char-1', role: 'character' },
    ];
    const characters = makeCharacters(['Alice', 'Bob']);
    const result = selectSpeaker(participants, characters, 'Bob what do you think?');
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'part-1');
});
