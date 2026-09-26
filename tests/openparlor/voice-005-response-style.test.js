import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildPrompt } from '../../src/openparlor/prompt-builder.js';
import {
    buildResponseStyleGuidance,
    normalizeResponseMode,
    normalizeVoiceResponseLength,
    isSpokenMode,
    VOICE_RESPONSE_LENGTHS,
} from '../../src/openparlor/response-style.js';
import { toSpeechText } from '../../public/openparlor/speech-text.js';

/**
 * VOICE-005 — conversational spoken-response style.
 *
 * The seven required behaviours are numbered 1-7 exactly as the specification
 * lists them.
 */

const CHARACTER = {
    id: 'char-1',
    name: 'Monica',
    system_prompt: 'You are sharp-tongued and analytical. You always answer in complete formal sentences.',
    scenario: 'A late-night conversation about a film.',
};

/** Build a prompt; the baseline is a bare text-mode turn. */
function build(overrides = {}) {
    return buildPrompt({
        character: CHARACTER,
        conversation: { id: 'conv-1', participants: [] },
        history: [],
        newMessages: [{ role: 'user', content: 'hello' }],
        ...overrides,
    });
}
const systemOf = (messages) => messages[0].content;

describe('VOICE-005: conversational spoken-response style', () => {
    it('1. voice guidance only appears when appropriate', () => {
        assert.equal(buildResponseStyleGuidance({ mode: 'text' }), '');
        assert.notEqual(buildResponseStyleGuidance({ mode: 'voice', length: 'normal' }), '');
        assert.notEqual(buildResponseStyleGuidance({ mode: 'hands_free', length: 'normal' }), '');

        const text = systemOf(build({ responseMode: 'text' }));
        assert.ok(!/synthesizer/i.test(text), 'text mode gets no voice guidance');
        assert.match(systemOf(build({ responseMode: 'voice' })), /synthesizer/i);
        assert.match(systemOf(build({ responseMode: 'hands_free' })), /synthesizer/i);
    });

    it('2. text-only chat remains unchanged', () => {
        // The strongest form of "unchanged": byte-identical to the prompt built
        // with no mode at all, including when a bogus mode is sent.
        const baseline = systemOf(build());
        assert.equal(systemOf(build({ responseMode: 'text' })), baseline);
        assert.equal(systemOf(build({ responseMode: 'text', voiceResponseLength: 'concise' })), baseline);
        assert.equal(systemOf(build({ responseMode: 'nonsense' })), baseline,
            'an unknown mode must not alter the prompt');
    });

    it('3. character prompt remains authoritative', () => {
        const prompt = systemOf(build({ responseMode: 'voice' }));
        // The character's own words survive untouched...
        assert.ok(prompt.includes(CHARACTER.system_prompt), 'the persona is preserved verbatim');
        assert.ok(prompt.includes(`Your name is ${CHARACTER.name}`), 'identity is preserved');
        // ...and the guidance explicitly subordinates itself, because a bare
        // "be brief" rule is exactly what a model applies to a character's
        // defining traits if left unqualified.
        assert.match(prompt, /outranks these notes/i);
        assert.match(prompt, /changes delivery ONLY/i);
    });

    it('4. hidden reasoning never enters speech', () => {
        const cases = [
            '<think>the user wants me to be warm here. Let me consider</think>Hey there.',
            '<thinking>deliberating at length about tone</thinking>Hi.',
            '<analysis>internal notes</analysis>Hello.',
            'Sure.\n<think>now I should mention the weather',
        ];
        for (const raw of cases) {
            const spoken = toSpeechText(raw);
            assert.ok(!/<\/?think/i.test(spoken), `tag leaked: ${spoken}`);
            assert.ok(!/deliberating|internal notes|let me consider/i.test(spoken),
                `reasoning content leaked: ${spoken}`);
        }
        assert.match(toSpeechText('<think>x</think>Hey there.'), /Hey there/);
    });

    it('4b. formatting, links, and code are not spoken', () => {
        assert.equal(toSpeechText('```js\nconst a = 1;\n```'), '');
        assert.equal(toSpeechText('![a photo](http://x/y.png)'), '');
        assert.equal(toSpeechText('**bold** and *italic* and ~~struck~~'), 'bold and italic and struck');
        assert.equal(toSpeechText('See [the docs](https://example.com/page) now.'), 'See the docs now.');
        assert.ok(!/https?:|www\./i.test(toSpeechText('Go to https://example.com/x please.')));
        assert.equal(toSpeechText('- one\n- two'), 'one. two');
        assert.equal(toSpeechText('## Heading\nBody text'), 'Heading. Body text');
        assert.equal(toSpeechText('> quoted line'), 'quoted line');
    });

    it('4c. cleanup does not corrupt ordinary prose', () => {
        // The failure mode a naive regex introduces: emphasis stripping that
        // eats snake_case identifiers, arithmetic, and bare hyphens.
        assert.equal(toSpeechText('call snake_case_name now'), 'call snake_case_name now');
        assert.equal(toSpeechText('it is -5 degrees out'), 'it is -5 degrees out');
        assert.equal(toSpeechText('2 * 3 * 4 = 24'), '2 * 3 * 4 = 24');
        assert.equal(toSpeechText('I\'m fine, aren\'t you?'), 'I\'m fine, aren\'t you?');
        assert.equal(toSpeechText(''), '');
        assert.equal(toSpeechText(null), '');
    });

    it('5. multi-character identity is retained', () => {
        const prompt = systemOf(build({
            responseMode: 'voice',
            participantContext: [
                { participant_id: 'p1', character_id: 'char-1', name: 'Monica' },
                { participant_id: 'p2', character_id: 'char-2', name: 'Doug' },
            ],
        }));
        assert.ok(prompt.includes('Monica') && prompt.includes('Doug'), 'both names survive');
        assert.match(prompt, /the human user/i, 'the group/human distinction survives');
        assert.match(prompt, /said to the group/i, 'the speaker-label contract survives');
        assert.match(prompt, /synthesizer/i, 'and voice guidance is still present');
    });

    it('6. preference persists and is applied', () => {
        for (const length of VOICE_RESPONSE_LENGTHS) {
            assert.equal(normalizeVoiceResponseLength(length), length);
            assert.match(systemOf(build({ responseMode: 'voice', voiceResponseLength: length })),
                /synthesizer/i, `guidance missing for ${length}`);
        }
        const concise = buildResponseStyleGuidance({ mode: 'voice', length: 'concise' });
        const detailed = buildResponseStyleGuidance({ mode: 'voice', length: 'detailed' });
        assert.notEqual(concise, detailed, 'length preference must change the guidance');
        assert.match(concise, /one or two sentences/i);
        // An unknown stored value falls back rather than throwing.
        assert.equal(normalizeVoiceResponseLength('garbage'), 'normal');
        assert.equal(buildResponseStyleGuidance({ mode: 'voice', length: 'garbage' }),
            buildResponseStyleGuidance({ mode: 'voice', length: 'normal' }));
    });

    it('7. another conversation does not inherit stale mode state', () => {
        // The mode is a property of the REQUEST, not of the conversation, so a
        // follow-up turn with no mode yields the text policy again even though
        // the previous turn was spoken.
        assert.match(systemOf(build({ responseMode: 'voice' })), /synthesizer/i);
        const nextTurn = systemOf(build());
        assert.ok(!/synthesizer/i.test(nextTurn),
            'a later text turn must not inherit the voice policy');
        assert.equal(nextTurn, systemOf(build({ responseMode: 'text' })));
    });

    it('mode and length are validated at the boundary', () => {
        assert.equal(normalizeResponseMode('voice'), 'voice');
        assert.equal(normalizeResponseMode('hands_free'), 'hands_free');
        for (const bad of ['', null, undefined, 42, 'VOICE', { mode: 'voice' }, 'text ']) {
            assert.equal(normalizeResponseMode(bad), 'text',
                `expected text fallback for ${JSON.stringify(bad)}`);
        }
        assert.equal(isSpokenMode('voice'), true);
        assert.equal(isSpokenMode('hands_free'), true);
        assert.equal(isSpokenMode('text'), false);
        assert.equal(isSpokenMode(undefined), false);
    });

    it('guidance asks for the specific things the spec lists', () => {
        const g = buildResponseStyleGuidance({ mode: 'voice', length: 'normal' });
        for (const [label, pattern] of [
            ['short turns', /Keep turns short/i],
            ['contractions', /contractions/i],
            ['no markdown', /markdown/i],
            ['no parentheticals', /parenthetical/i],
            ['no repeated summary', /restate|summarise|summarize/i],
        ]) {
            assert.match(g, pattern, `guidance should mention ${label}`);
        }
    });
});
