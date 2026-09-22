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

// ─── Whole-group intent (QWEN-GROUP-001) ─────────────────────────────────────

test('selects all character participants for "everyone say hello"', () => {
    const participants = makeParticipants(['Doug', 'Monica', 'Rachel']);
    const characters = makeCharacters(['Doug', 'Monica', 'Rachel']);
    const result = selectSpeaker(participants, characters, 'everyone say hello');
    assert.deepEqual(result.map(p => p.id), ['part-0', 'part-1', 'part-2']);
});

test('selects all character participants for "everybody say hello"', () => {
    const participants = makeParticipants(['Doug', 'Monica', 'Rachel']);
    const characters = makeCharacters(['Doug', 'Monica', 'Rachel']);
    const result = selectSpeaker(participants, characters, 'everybody say hello');
    assert.deepEqual(result.map(p => p.id), ['part-0', 'part-1', 'part-2']);
});

test('selects all character participants for "all of you say hello"', () => {
    const participants = makeParticipants(['Doug', 'Monica', 'Rachel']);
    const characters = makeCharacters(['Doug', 'Monica', 'Rachel']);
    const result = selectSpeaker(participants, characters, 'all of you say hello');
    assert.deepEqual(result.map(p => p.id), ['part-0', 'part-1', 'part-2']);
});

test('selects all character participants for "you all say hello"', () => {
    const participants = makeParticipants(['Doug', 'Monica', 'Rachel']);
    const characters = makeCharacters(['Doug', 'Monica', 'Rachel']);
    const result = selectSpeaker(participants, characters, 'you all say hello');
    assert.deepEqual(result.map(p => p.id), ['part-0', 'part-1', 'part-2']);
});

test('selects both characters in a two-character chat for "both of you say hello"', () => {
    const participants = makeParticipants(['Doug', 'Monica']);
    const characters = makeCharacters(['Doug', 'Monica']);
    const result = selectSpeaker(participants, characters, 'both of you say hello');
    assert.deepEqual(result.map(p => p.id), ['part-0', 'part-1']);
});

test('selects both characters in a two-character chat for "you both say hello"', () => {
    const participants = makeParticipants(['Doug', 'Monica']);
    const characters = makeCharacters(['Doug', 'Monica']);
    const result = selectSpeaker(participants, characters, 'you both say hello');
    assert.deepEqual(result.map(p => p.id), ['part-0', 'part-1']);
});

test('selects both characters in a two-character chat for "you two say hello"', () => {
    const participants = makeParticipants(['Doug', 'Monica']);
    const characters = makeCharacters(['Doug', 'Monica']);
    const result = selectSpeaker(participants, characters, 'you two say hello');
    assert.deepEqual(result.map(p => p.id), ['part-0', 'part-1']);
});

test('selects both characters in a two-character chat for the bare word "both"', () => {
    const participants = makeParticipants(['Doug', 'Monica']);
    const characters = makeCharacters(['Doug', 'Monica']);
    const result = selectSpeaker(participants, characters, 'Tell both a joke');
    assert.deepEqual(result.map(p => p.id), ['part-0', 'part-1']);
});

test('"Monica, what do you think?" selects Monica only', () => {
    const participants = makeParticipants(['Doug', 'Monica']);
    const characters = makeCharacters(['Doug', 'Monica']);
    const result = selectSpeaker(participants, characters, 'Monica, what do you think?');
    assert.deepEqual(result.map(p => p.id), ['part-1']);
});

test('"Doug and Monica answer" selects both in participant order', () => {
    const participants = makeParticipants(['Doug', 'Monica', 'Rachel']);
    const characters = makeCharacters(['Doug', 'Monica', 'Rachel']);
    const result = selectSpeaker(participants, characters, 'Doug and Monica answer');
    assert.deepEqual(result.map(p => p.id), ['part-0', 'part-1']);
});

test('whole-group cue takes precedence over an explicit name', () => {
    const participants = makeParticipants(['Doug', 'Monica']);
    const characters = makeCharacters(['Doug', 'Monica']);
    const result = selectSpeaker(participants, characters, 'Monica, can everyone say hello?');
    assert.deepEqual(result.map(p => p.id), ['part-0', 'part-1']);
});

test('"That\'s all I wanted to say" does NOT select the whole group', () => {
    const participants = makeParticipants(['Doug', 'Monica']);
    const characters = makeCharacters(['Doug', 'Monica']);
    const result = selectSpeaker(participants, characters, "That's all I wanted to say.");
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'part-0');
});

test('"both of you" does not select everyone in a three-character chat', () => {
    const participants = makeParticipants(['Doug', 'Monica', 'Rachel']);
    const characters = makeCharacters(['Doug', 'Monica', 'Rachel']);
    const result = selectSpeaker(participants, characters, 'both of you say hello');
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'part-0');
});

test('"you two" does not select everyone in a three-character chat', () => {
    const participants = makeParticipants(['Doug', 'Monica', 'Rachel']);
    const characters = makeCharacters(['Doug', 'Monica', 'Rachel']);
    const result = selectSpeaker(participants, characters, 'you two say hello');
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'part-0');
});

test('generic unnamed turn keeps deterministic first-character fallback', () => {
    const participants = makeParticipants(['Doug', 'Monica']);
    const characters = makeCharacters(['Doug', 'Monica']);
    const result = selectSpeaker(participants, characters, 'What should we do today?');
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'part-0');
});

test('direct address takes precedence over a name mentioned in the question', () => {
    const participants = makeParticipants(['Doug', 'Monica']);
    const characters = makeCharacters(['Doug', 'Monica']);
    const result = selectSpeaker(participants, characters, 'Doug, what did Monica just say?');
    assert.deepEqual(result.map(p => p.id), ['part-0']);
});

test('direct address takes precedence (symmetric): "Monica, what did Doug say?"', () => {
    const participants = makeParticipants(['Doug', 'Monica']);
    const characters = makeCharacters(['Doug', 'Monica']);
    const result = selectSpeaker(participants, characters, 'Monica, what did Doug say?');
    assert.deepEqual(result.map(p => p.id), ['part-1']);
});

test('comma-terminated address list selects all addressed characters in participant order', () => {
    const participants = makeParticipants(['Doug', 'Monica', 'Rachel']);
    const characters = makeCharacters(['Doug', 'Monica', 'Rachel']);
    const result = selectSpeaker(participants, characters, 'Doug and Monica, answer this');
    assert.deepEqual(result.map(p => p.id), ['part-0', 'part-1']);
});

test('direct address with greeting selects the addressed character only', () => {
    const participants = makeParticipants(['Doug', 'Monica', 'Rachel']);
    const characters = makeCharacters(['Doug', 'Monica', 'Rachel']);
    const result = selectSpeaker(participants, characters, 'Hey Doug, what does Monica think?');
    assert.deepEqual(result.map(p => p.id), ['part-0']);
});

test('a non-first participant addressed directly answers instead of the first participant', () => {
    const participants = makeParticipants(['Doug', 'Monica', 'Rachel']);
    const characters = makeCharacters(['Doug', 'Monica', 'Rachel']);
    const result = selectSpeaker(participants, characters, 'Rachel, tell me what Doug and Monica said');
    assert.deepEqual(result.map(p => p.id), ['part-2']);
});

test('mid-sentence vocative comma selects the addressed character only', () => {
    const participants = makeParticipants(['Doug', 'Monica']);
    const characters = makeCharacters(['Doug', 'Monica']);
    const result = selectSpeaker(participants, characters, 'I think, Doug, that you\'re right');
    assert.deepEqual(result.map(p => p.id), ['part-0']);
});

test('name without a following comma falls back to mention matching', () => {
    const participants = makeParticipants(['Doug', 'Monica']);
    const characters = makeCharacters(['Doug', 'Monica']);
    const result = selectSpeaker(participants, characters, 'What did Doug think?');
    assert.deepEqual(result.map(p => p.id), ['part-0']);
});

test('whole-group cue still takes precedence over direct address', () => {
    const participants = makeParticipants(['Doug', 'Monica']);
    const characters = makeCharacters(['Doug', 'Monica']);
    const result = selectSpeaker(participants, characters, 'Doug, everyone, say hello');
    assert.deepEqual(result.map(p => p.id), ['part-0', 'part-1']);
});
