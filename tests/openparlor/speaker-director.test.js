import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
    buildDirectorPrompt,
    findPendingQuestionAsker,
    leastRecentlySpoken,
    parseDirectorDecision,
    selectSpeaker,
    selectSpeakerByRules,
    selectSpeakers,
} from '../../src/openparlor/speaker-director.js';

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
    const participants = makeParticipants(['O\'Brien', 'Smith']);
    const characters = makeCharacters(['O\'Brien', 'Smith']);
    const result = selectSpeaker(participants, characters, 'Hey O\'Brien, what\'s up?');
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
    const result = selectSpeaker(participants, characters, 'That\'s all I wanted to say.');
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

// ─── STAB-006: rule selection, anti-starvation rotation, model director ──────

test('selectSpeakerByRules matches selectSpeaker when a deterministic rule fires', () => {
    const participants = makeParticipants(['Alice', 'Bob', 'Charlie']);
    const characters = makeCharacters(['Alice', 'Bob', 'Charlie']);
    assert.deepEqual(selectSpeakerByRules(participants, characters, 'Hey Bob'), selectSpeaker(participants, characters, 'Hey Bob'));
    assert.deepEqual(selectSpeakerByRules(participants, characters, 'everyone, hi'), selectSpeaker(participants, characters, 'everyone, hi'));
    assert.deepEqual(selectSpeakerByRules(participants, characters, 'Alice, hi'), selectSpeaker(participants, characters, 'Alice, hi'));
});

test('selectSpeakerByRules returns null for ambiguous multi-character turns', () => {
    const participants = makeParticipants(['Alice', 'Bob', 'Charlie']);
    const characters = makeCharacters(['Alice', 'Bob', 'Charlie']);
    assert.equal(selectSpeakerByRules(participants, characters, 'what should we do?'), null);
});

test('selectSpeakerByRules returns an empty array when no character participants exist', () => {
    const participants = [{ id: 'p1', character_id: 'c1', role: 'user' }];
    assert.deepEqual(selectSpeakerByRules(participants, [], 'hello'), []);
});

test('leastRecentlySpoken picks the first character when nobody has spoken yet', () => {
    const participants = makeParticipants(['Alice', 'Bob', 'Charlie']);
    assert.deepEqual(leastRecentlySpoken(participants, []).map(p => p.id), ['part-0']);
});

test('leastRecentlySpoken rotates to the least recently spoken character', () => {
    const participants = makeParticipants(['Alice', 'Bob']);
    const history = [
        { role: 'character', participant_id: 'part-0' },
        { role: 'character', participant_id: 'part-1' },
        { role: 'character', participant_id: 'part-0' },
    ];
    assert.deepEqual(leastRecentlySpoken(participants, history).map(p => p.id), ['part-1']);
    // The character with zero speeches wins outright.
    const three = makeParticipants(['Alice', 'Bob', 'Charlie']);
    assert.deepEqual(leastRecentlySpoken(three, history).map(p => p.id), ['part-2']);
    // Tie on counts resolves in participant order.
    const tie = [
        { role: 'character', participant_id: 'part-0' },
        { role: 'character', participant_id: 'part-1' },
    ];
    assert.deepEqual(leastRecentlySpoken(participants, tie).map(p => p.id), ['part-0']);
});

test('leastRecentlySpoken ignores unknown and user participant IDs', () => {
    const participants = makeParticipants(['Alice', 'Bob']);
    const history = [
        { role: 'character', participant_id: 'ghost-participant' },
        { role: 'user', participant_id: 'part-1' },
        { role: 'character', participant_id: 'part-1' },
    ];
    // Only part-1 counts; part-0 is least spoken.
    assert.deepEqual(leastRecentlySpoken(participants, history).map(p => p.id), ['part-0']);
    assert.deepEqual(leastRecentlySpoken([{ id: 'u1', character_id: 'c1', role: 'user' }], []).map(p => p.id), []);
});

test('leastRecentlySpoken returns the single character even with history', () => {
    const participants = makeParticipants(['Alice']);
    assert.deepEqual(leastRecentlySpoken(participants, [{ role: 'character', participant_id: 'part-0' }]).map(p => p.id), ['part-0']);
});


test('parseDirectorDecision accepts a valid JSON decision with allowed IDs', () => {
    const allowed = ['char-0', 'char-1'];
    assert.deepEqual(parseDirectorDecision('{"speakers": ["char-1"], "reason": "variety"}', allowed), ['char-1']);
    assert.deepEqual(parseDirectorDecision('{"speakers": ["char-0", "char-1"]}', allowed), ['char-0', 'char-1']);
    // Plain objects are accepted too.
    assert.deepEqual(parseDirectorDecision({ speakers: ['char-0'] }, allowed), ['char-0']);
});

test('parseDirectorDecision tolerates code fences and surrounding prose', () => {
    const allowed = ['char-0'];
    const fenced = '```json\n{"speakers": ["char-0"], "reason": "r"}\n```';
    assert.deepEqual(parseDirectorDecision(fenced, allowed), ['char-0']);
    assert.deepEqual(parseDirectorDecision('Sure! Here is the decision:\n{"speakers": ["char-0"]} thanks', allowed), ['char-0']);
});

test('parseDirectorDecision rejects malformed or empty decisions', () => {
    const allowed = ['char-0', 'char-1'];
    assert.equal(parseDirectorDecision('not json at all', allowed), null);
    assert.equal(parseDirectorDecision('{"speakers": ', allowed), null);
    assert.equal(parseDirectorDecision('{"speakers": []}', allowed), null);
    assert.equal(parseDirectorDecision('{"speakers": "char-0"}', allowed), null);
    assert.equal(parseDirectorDecision('{"reason": "no speakers field"}', allowed), null);
    assert.equal(parseDirectorDecision('{"speakers": [1, 2]}', allowed), null);
    assert.equal(parseDirectorDecision(null, allowed), null);
    assert.equal(parseDirectorDecision(42, allowed), null);
    assert.equal(parseDirectorDecision(['char-0'], allowed), null);
});

test('parseDirectorDecision never permits arbitrary or unknown IDs', () => {
    const allowed = ['char-0', 'char-1'];
    assert.equal(parseDirectorDecision('{"speakers": ["char-9"]}', allowed), null);
    assert.equal(parseDirectorDecision('{"speakers": ["char-0", "char-9"]}', allowed), null, 'one bad ID invalidates the whole decision');
    assert.equal(parseDirectorDecision('{"speakers": [""]}', allowed), null);
    assert.equal(parseDirectorDecision('{"speakers": ["char-0"]}', []), null, 'empty allow-list rejects everything');
});

test('parseDirectorDecision deduplicates IDs while preserving order', () => {
    const allowed = ['char-0', 'char-1'];
    assert.deepEqual(parseDirectorDecision('{"speakers": ["char-1", "char-0", "char-1"]}', allowed), ['char-1', 'char-0']);
});

test('buildDirectorPrompt frames a strict structured choice over known characters only', () => {
    const participants = makeParticipants(['Alice', 'Bob']);
    const characters = makeCharacters(['Alice', 'Bob']);
    const prompt = buildDirectorPrompt({
        participants,
        characters,
        userMessage: 'what should we do?',
        recentMessages: [{ role: 'character', participant_id: 'part-0', content: 'I would like tea.' }],
    });
    assert.equal(prompt.length, 2);
    assert.equal(prompt[0].role, 'system');
    assert.equal(prompt[1].role, 'user');
    assert.ok(prompt[0].content.includes('"speakers"'), 'must demand the speakers array shape');
    assert.ok(prompt[0].content.toLowerCase().includes('json'));
    assert.ok(prompt[1].content.includes('char-0') && prompt[1].content.includes('char-1'), 'IDs must be listed for selection');
    assert.ok(prompt[1].content.includes('Alice') && prompt[1].content.includes('Bob'));
    assert.ok(prompt[1].content.includes('what should we do?'));
    assert.ok(prompt[1].content.includes('I would like tea.'));
    // Malformed inputs are safe.
    const safe = buildDirectorPrompt({ participants: null, characters: null, userMessage: null, recentMessages: null });
    assert.ok(typeof safe[1].content === 'string' && !safe[1].content.includes('[object Object]'));
});


test('selectSpeakers prefers deterministic rules and never calls the model for them', async () => {
    const participants = makeParticipants(['Alice', 'Bob', 'Charlie']);
    const characters = makeCharacters(['Alice', 'Bob', 'Charlie']);
    let calls = 0;
    const provider = { chatCompletion: async () => { calls++; return { choices: [{ message: { content: '{"speakers": ["char-0"]}' } }] }; } };
    const result = await selectSpeakers({ participants, characters, userMessage: 'Hey Bob', provider });
    assert.deepEqual(result.map(p => p.id), ['part-1']);
    assert.equal(calls, 0);
    const group = await selectSpeakers({ participants, characters, userMessage: 'everyone, hi', provider });
    assert.equal(group.length, 3);
    assert.equal(calls, 0, 'group cues are deterministic and must not consult the model');
});

test('selectSpeakers honors a valid model decision for ambiguous turns', async () => {
    const participants = makeParticipants(['Alice', 'Bob', 'Charlie']);
    const characters = makeCharacters(['Alice', 'Bob', 'Charlie']);
    const seen = [];
    const provider = {
        chatCompletion: async messages => {
            seen.push(messages);
            return { choices: [{ message: { content: '{"speakers": ["char-2"], "reason": "not spoken recently"}' } }] };
        },
    };
    const result = await selectSpeakers({ participants, characters, userMessage: 'what should we do?', provider });
    assert.deepEqual(result.map(p => p.id), ['part-2']);
    assert.equal(seen.length, 1);
    assert.ok(seen[0][1].content.includes('what should we do?'));
});

test('selectSpeakers falls back to least-recently-spoken when the model decision is invalid', async () => {
    const participants = makeParticipants(['Alice', 'Bob']);
    const characters = makeCharacters(['Alice', 'Bob']);
    const history = [
        { role: 'character', participant_id: 'part-0', content: 'hi' },
    ];
    const provider = {
        chatCompletion: async () => ({ choices: [{ message: { content: 'I think Bob should answer.' } }] }),
    };
    const result = await selectSpeakers({ participants, characters, userMessage: 'hmm', recentMessages: history, provider });
    assert.deepEqual(result.map(p => p.id), ['part-1'], 'invalid output must fall back to deterministic rotation, not the first character');
});

test('selectSpeakers falls back to least-recently-spoken when the model call throws', async () => {
    const participants = makeParticipants(['Alice', 'Bob']);
    const characters = makeCharacters(['Alice', 'Bob']);
    const provider = { chatCompletion: async () => { throw new Error('model offline'); } };
    const result = await selectSpeakers({ participants, characters, userMessage: 'hmm', recentMessages: [{ role: 'character', participant_id: 'part-0' }], provider });
    assert.deepEqual(result.map(p => p.id), ['part-1']);
});

test('selectSpeakers works without a provider using deterministic rotation', async () => {
    const participants = makeParticipants(['Alice', 'Bob', 'Charlie']);
    const characters = makeCharacters(['Alice', 'Bob', 'Charlie']);
    const fresh = await selectSpeakers({ participants, characters, userMessage: 'hmm' });
    assert.deepEqual(fresh.map(p => p.id), ['part-0'], 'no history: first character, as before');
    const rotated = await selectSpeakers({
        participants,
        characters,
        userMessage: 'hmm',
        recentMessages: [{ role: 'character', participant_id: 'part-0' }],
    });
    assert.deepEqual(rotated.map(p => p.id), ['part-1'], 'the least recently spoken character goes next');
});

test('selectSpeakers returns an empty array when no character participants exist', async () => {
    const participants = [{ id: 'p1', character_id: 'c1', role: 'user' }];
    const result = await selectSpeakers({ participants, characters: [], userMessage: 'hello' });
    assert.deepEqual(result, []);
});

test('selectSpeakers maps multiple model-selected IDs to participants in participant order', async () => {
    const participants = makeParticipants(['Alice', 'Bob', 'Charlie']);
    const characters = makeCharacters(['Alice', 'Bob', 'Charlie']);
    const provider = {
        chatCompletion: async () => ({ choices: [{ message: { content: '{"speakers": ["char-2", "char-0"]}' } }] }),
    };
    const result = await selectSpeakers({ participants, characters, userMessage: 'hmm', provider });
    assert.deepEqual(result.map(p => p.id), ['part-0', 'part-2']);
});

// ─── DOGFOOD-002: guys/folks collective-address cues ─────────────────────────

test('"hey guys" selects all participants in a two-character chat', () => {
    const participants = makeParticipants(['Doug', 'Monica']);
    const characters = makeCharacters(['Doug', 'Monica']);
    const result = selectSpeaker(participants, characters, 'hey guys');
    assert.deepEqual(result.map(p => p.id), ['part-0', 'part-1']);
});

test('"hi guys" selects all participants in a two-character chat', () => {
    const participants = makeParticipants(['Doug', 'Monica']);
    const characters = makeCharacters(['Doug', 'Monica']);
    const result = selectSpeaker(participants, characters, 'hi guys');
    assert.deepEqual(result.map(p => p.id), ['part-0', 'part-1']);
});

test('"hello guys" selects all participants in a two-character chat', () => {
    const participants = makeParticipants(['Doug', 'Monica']);
    const characters = makeCharacters(['Doug', 'Monica']);
    const result = selectSpeaker(participants, characters, 'hello guys');
    assert.deepEqual(result.map(p => p.id), ['part-0', 'part-1']);
});

test('"you guys" selects all participants in a two-character chat', () => {
    const participants = makeParticipants(['Doug', 'Monica']);
    const characters = makeCharacters(['Doug', 'Monica']);
    const result = selectSpeaker(participants, characters, 'you guys, what do you think?');
    assert.deepEqual(result.map(p => p.id), ['part-0', 'part-1']);
});

test('"what do you guys think" selects all participants', () => {
    const participants = makeParticipants(['Doug', 'Monica']);
    const characters = makeCharacters(['Doug', 'Monica']);
    const result = selectSpeaker(participants, characters, 'what do you guys think?');
    assert.deepEqual(result.map(p => p.id), ['part-0', 'part-1']);
});

test('"hey guys" selects all participants in a three-character chat', () => {
    const participants = makeParticipants(['Doug', 'Monica', 'Rachel']);
    const characters = makeCharacters(['Doug', 'Monica', 'Rachel']);
    const result = selectSpeaker(participants, characters, 'hey guys, say hi');
    assert.deepEqual(result.map(p => p.id), ['part-0', 'part-1', 'part-2']);
});

test('"you folks" selects all participants in a two-character chat', () => {
    const participants = makeParticipants(['Doug', 'Monica']);
    const characters = makeCharacters(['Doug', 'Monica']);
    const result = selectSpeaker(participants, characters, 'you folks, what do you think?');
    assert.deepEqual(result.map(p => p.id), ['part-0', 'part-1']);
});

test('"hey folks" selects all participants in a two-character chat', () => {
    const participants = makeParticipants(['Doug', 'Monica']);
    const characters = makeCharacters(['Doug', 'Monica']);
    const result = selectSpeaker(participants, characters, 'hey folks');
    assert.deepEqual(result.map(p => p.id), ['part-0', 'part-1']);
});

test('"I saw those guys yesterday" does NOT select the whole group', () => {
    const participants = makeParticipants(['Doug', 'Monica']);
    const characters = makeCharacters(['Doug', 'Monica']);
    const result = selectSpeaker(participants, characters, 'I saw those guys yesterday');
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'part-0');
});

test('"the guys next door" does NOT select the whole group', () => {
    const participants = makeParticipants(['Doug', 'Monica']);
    const characters = makeCharacters(['Doug', 'Monica']);
    const result = selectSpeaker(participants, characters, 'the guys next door are loud');
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'part-0');
});

test('"these guys are cool" does NOT select the whole group', () => {
    const participants = makeParticipants(['Doug', 'Monica']);
    const characters = makeCharacters(['Doug', 'Monica']);
    const result = selectSpeaker(participants, characters, 'these guys are cool');
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'part-0');
});

test('"guys" alone without a second-person or vocative marker does NOT select the whole group', () => {
    const participants = makeParticipants(['Doug', 'Monica']);
    const characters = makeCharacters(['Doug', 'Monica']);
    const result = selectSpeaker(participants, characters, 'my guys are coming over');
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'part-0');
});

// ─── Regression: the character who asked the question answers the reply ──────
//
// Reported case: Monica introduced herself, Doug said "I'm Doug, by the way.
// What's your name?", the user replied "Oh, my name is Mark.", and Monica —
// not Doug — answered. Two independent defects combined:
//
//   1. "Oh, my name is Mark." names nobody and carries no group cue, so every
//      deterministic rule missed and the turn went to the model director (or
//      its fallback). Nothing looked at the outstanding question.
//   2. The director prompt labelled the transcript with participant IDs while
//      asking for character IDs, so it could not tell that Doug had asked.
//
// The pending-question rule fixes (1) deterministically; the name mapping
// fixes (2) for the genuinely ambiguous turns that still reach the model.
const PQ_PARTICIPANTS = [
    { id: 'part-monica', character_id: 'char-monica', role: 'character' },
    { id: 'part-doug', character_id: 'char-doug', role: 'character' },
];
const PQ_CHARACTERS = [
    { id: 'char-monica', name: 'Monica' },
    { id: 'char-doug', name: 'Doug' },
];
const PQ_HISTORY = [
    { role: 'character', participant_id: 'part-monica', content: 'I\'m Monica! I\'m just taking it easy right now.' },
    { role: 'character', participant_id: 'part-doug', content: 'I\'m Doug, by the way. What\'s your name?' },
];
const pqNameOf = (participants) => participants
    .map(p => PQ_CHARACTERS.find(c => c.id === p.character_id).name);

describe('pending question: the asker answers the user', () => {
    test('routes the reported message to Doug, not Monica', () => {
        const result = selectSpeakerByRules(
            PQ_PARTICIPANTS, PQ_CHARACTERS, 'Oh, my name is Mark.', PQ_HISTORY,
        );
        assert.ok(result, 'the turn must be decided deterministically, not sent to the model');
        assert.deepEqual(pqNameOf(result), ['Doug']);
    });

    test('never consults the model for an outstanding question', async () => {
        let called = 0;
        const provider = {
            chatCompletion: async () => {
                called += 1;
                // A provider that would have chosen wrongly must never run.
                return { choices: [{ message: { content: '{"speakers":["char-monica"]}' } }] };
            },
        };
        const result = await selectSpeakers({
            participants: PQ_PARTICIPANTS,
            characters: PQ_CHARACTERS,
            userMessage: 'Oh, my name is Mark.',
            recentMessages: PQ_HISTORY,
            provider,
        });
        assert.equal(called, 0, 'the model must not be consulted when a question is outstanding');
        assert.deepEqual(pqNameOf(result), ['Doug']);
    });

    test('a later user turn does not re-capture a long-answered question', () => {
        const history = [
            ...PQ_HISTORY,
            { role: 'user', content: 'Oh, my name is Mark.' },
            { role: 'character', participant_id: 'part-doug', content: 'Nice to meet you, Mark.' },
        ];
        assert.equal(findPendingQuestionAsker(PQ_PARTICIPANTS, history), null,
            'a question asked before the last user turn is already answered');
    });

    test('an explicit name still wins over conversational continuity', () => {
        const result = selectSpeakerByRules(
            PQ_PARTICIPANTS, PQ_CHARACTERS, 'Monica, what do you think?', PQ_HISTORY,
        );
        assert.deepEqual(pqNameOf(result), ['Monica']);
    });

    test('a whole-group cue still wins over conversational continuity', () => {
        const result = selectSpeakerByRules(
            PQ_PARTICIPANTS, PQ_CHARACTERS, 'what do you all think?', PQ_HISTORY,
        );
        assert.equal(result.length, 2, 'both characters answer an open question to the group');
    });

    test('a question addressed to another character is not a pending question', () => {
        // Doug asks MONICA, not the user, so the user's reply is not an
        // answer to Doug.
        const history = [
            { role: 'character', participant_id: 'part-doug', content: 'Monica, did you get the delivery?' },
        ];
        assert.equal(findPendingQuestionAsker(PQ_PARTICIPANTS, history), null);
    });

    test('a rhetorical question earlier in the message does not capture the turn', () => {
        const history = [
            { role: 'character', participant_id: 'part-doug', content: 'Wasn\'t that something? Anyway, nice weather.' },
        ];
        assert.equal(findPendingQuestionAsker(PQ_PARTICIPANTS, history), null);
    });

    test('only the most recent question matters', () => {
        const history = [
            { role: 'character', participant_id: 'part-doug', content: 'What\'s your name?' },
            { role: 'character', participant_id: 'part-monica', content: 'How are you?' },
        ];
        const asker = findPendingQuestionAsker(PQ_PARTICIPANTS, history);
        assert.equal(asker.character_id, 'char-monica', 'the newest question wins');
    });

    test('a statement is not a pending question', () => {
        const history = [
            { role: 'character', participant_id: 'part-doug', content: 'I\'m Doug, by the way. It\'s been a long day.' },
        ];
        assert.equal(findPendingQuestionAsker(PQ_PARTICIPANTS, history), null);
    });

    test('an unresolvable participant_id does not crash the scan', () => {
        const history = [
            { role: 'character', participant_id: 'part-gone', content: 'What\'s your name?' },
        ];
        assert.equal(findPendingQuestionAsker(PQ_PARTICIPANTS, history), null);
    });
});

// ─── Regression: the director prompt must not mix ID namespaces ──────────────
describe('director prompt names its speakers', () => {
    test('labels the transcript with character names, not participant IDs', () => {
        const [system, user] = buildDirectorPrompt({
            participants: PQ_PARTICIPANTS,
            characters: PQ_CHARACTERS,
            userMessage: 'Oh, my name is Mark.',
            recentMessages: [
                { role: 'character', participant_id: 'part-doug', content: 'What\'s your name?' },
                { role: 'user', content: 'Oh, my name is Mark.' },
            ],
        });
        assert.ok(user.content.includes('Doug: What\'s your name?'),
            'the asker must be identifiable by name');
        assert.ok(user.content.includes('User: Oh, my name is Mark.'));
        assert.ok(!/Character part-/.test(user.content),
            'participant IDs must not label the transcript');
        assert.ok(!user.content.includes('part-doug'), 'no raw participant ID may appear');
        assert.ok(system.content.includes('NAMES'), 'the director is told the transcript uses names');
        assert.ok(system.content.includes('asked the user a question'),
            'the answer-the-asker rule is stated for genuinely ambiguous turns');
    });

    test('an unknown participant degrades to a readable placeholder', () => {
        const [, user] = buildDirectorPrompt({
            participants: PQ_PARTICIPANTS,
            characters: PQ_CHARACTERS,
            userMessage: 'hello',
            recentMessages: [{ role: 'character', participant_id: 'part-vanished', content: 'hi' }],
        });
        assert.ok(user.content.includes('Unknown character: hi'));
        assert.ok(!user.content.includes('undefined'));
    });

    test('the Characters list still offers exactly the answerable IDs', () => {
        const [, user] = buildDirectorPrompt({
            participants: PQ_PARTICIPANTS,
            characters: PQ_CHARACTERS,
            userMessage: 'hello',
            recentMessages: [],
        });
        assert.ok(user.content.includes('- id: char-doug (name: Doug)'));
        assert.ok(user.content.includes('- id: char-monica (name: Monica)'));
    });
});
