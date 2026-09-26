import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildPrompt, stripSelfAppliedSpeakerLabel } from '../../src/openparlor/prompt-builder.js';
import { createStreamMessageCollector } from '../../public/openparlor/conversations.js';

/**
 * Group speaker-label regression (found in dogfooding).
 *
 * The group transcript labels other characters' lines as
 * `[Name said to the group]: ...`. Showing a model that format teaches the
 * format, and it reproduced it in its own output. The strings in these tests
 * are the ones observed in real use, not invented.
 */

const GROUP = [
    { participant_id: 'p1', character_id: 'char-1', name: 'Monica' },
    { participant_id: 'p2', character_id: 'char-2', name: 'Doug' },
];

describe('group speaker label is never written by the speaker', () => {
    it('the prompt forbids the model from writing the label', () => {
        const prompt = buildPrompt({
            character: { id: 'char-1', name: 'Monica', system_prompt: 'p' },
            conversation: { id: 'c1', participants: [] },
            history: [],
            newMessages: [{ role: 'user', content: 'hi' }],
            participantContext: GROUP,
        })[0].content;
        // Describing the format is not enough: the observed bug was a model
        // copying it, so the prompt must explicitly prohibit producing it.
        assert.match(prompt, /Never write that label yourself/i);
    });

    it('strips a self-applied label (observed: a character quoting itself)', () => {
        assert.equal(
            stripSelfAppliedSpeakerLabel('[ Doug said to the group ]: Appreciate that, but you can just call me Doug. No need to be so formal. Welcome aboard.'),
            'Appreciate that, but you can just call me Doug. No need to be so formal. Welcome aboard.',
        );
    });

    it('strips a label naming ANOTHER character (observed: misattributed line)', () => {
        // Doug's turn contained Monica's line, and Monica's own bubble was
        // empty. The label has to go, or it is stored and re-fed as content.
        assert.equal(
            stripSelfAppliedSpeakerLabel('[ Monica said to the group ]: Doug\'s the fishing enthusiast, not me. I\'d rather be at the library or trying a new café. Doug, take the question'),
            'Doug\'s the fishing enthusiast, not me. I\'d rather be at the library or trying a new café. Doug, take the question',
        );
    });

    it('handles spacing and punctuation variants', () => {
        for (const label of [
            '[Doug said to the group]: hello',
            '[ Doug said to the group ]: hello',
            '[DOUG SAID TO THE GROUP]: hello',
            '[Doug said]: hello',
        ]) {
            assert.equal(stripSelfAppliedSpeakerLabel(label), 'hello', `failed on ${label}`);
        }
    });

    it('leaves ordinary speech alone', () => {
        // Over-eager stripping would eat real content. Brackets are common in
        // ordinary dialogue and must survive.
        for (const text of [
            'The [library] is closed on Sundays.',
            'She said to me that she would be late.',
            'I said to him, "not again", and he laughed.',
            'No label here at all.',
            '',
        ]) {
            assert.equal(stripSelfAppliedSpeakerLabel(text), text, `must not alter: ${text}`);
        }
    });

    it('the live streaming view is cleaned too', () => {
        // The label arrives split across deltas, so stripping must run on the
        // accumulated text or the user watches it appear and then vanish.
        const collector = createStreamMessageCollector();
        const chunks = ['[ Mon', 'ica said', ' to the gr', 'oup]: Doug', '\'s the fishing enthusiast.'];
        let last = null;
        for (const text of chunks) last = collector.handleRecord({ type: 'delta', text });
        assert.equal(last.message.content, 'Doug\'s the fishing enthusiast.',
            'the label must not survive in the live view');
    });

    it('a second speaker starts clean', () => {
        const collector = createStreamMessageCollector();
        collector.handleRecord({ type: 'speaker_start', character_id: 'char-2' });
        collector.handleRecord({ type: 'delta', text: 'Plain reply.' });
        const second = collector.handleRecord({ type: 'speaker_start', character_id: 'char-1' });
        // Snapshot the content now: the collector mutates the same object as
        // later deltas arrive, so holding the reference and asserting at the
        // end would compare against post-delta state.
        const atStart = second.message.content;
        collector.handleRecord({ type: 'delta', text: 'Another plain reply.' });
        assert.equal(atStart, '', 'a new speaker must not inherit the previous text');
        assert.equal(collector.getMessages().length, 2);
    });
});
