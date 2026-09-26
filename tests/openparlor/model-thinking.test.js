import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    THINKING_POLICIES,
    normalizeThinkingPolicy,
    shouldSuppressThinking,
} from '../../src/openparlor/model-thinking.js';

// The regression this guards: a reasoning model streamed 20-60 seconds of
// `reasoning_content` before its first visible token, and OpenParlor renders
// only `content`. In a spoken turn that read as a dead app; in a text turn it
// would have been a slow but correct answer to a hard question.
describe('reasoning-model thinking policy', () => {
    it('normalizes an unknown policy to auto', () => {
        for (const raw of [undefined, null, 0, '', 'AUTO', 'sometimes', {}, []]) {
            assert.equal(normalizeThinkingPolicy(raw), 'auto');
        }
        for (const policy of THINKING_POLICIES) {
            assert.equal(normalizeThinkingPolicy(policy), policy);
        }
    });

    it('auto suppresses thinking for spoken turns and allows it for text', () => {
        // A spoken turn cannot absorb an invisible wait: the user has just
        // finished talking and is waiting for the answer out loud.
        assert.equal(shouldSuppressThinking({ policy: 'auto', responseMode: 'voice' }), true);
        assert.equal(shouldSuppressThinking({ policy: 'auto', responseMode: 'hands_free' }), true);
        // A text turn shows a first-token estimate, and hard questions need
        // the reasoning.
        assert.equal(shouldSuppressThinking({ policy: 'auto', responseMode: 'text' }), false);
    });

    it('an unknown response mode is treated as text, so thinking is allowed', () => {
        assert.equal(shouldSuppressThinking({ policy: 'auto', responseMode: 'nonsense' }), false);
        assert.equal(shouldSuppressThinking({ policy: 'auto' }), false);
    });

    it('always and never override the medium', () => {
        assert.equal(shouldSuppressThinking({ policy: 'always', responseMode: 'voice' }), false);
        assert.equal(shouldSuppressThinking({ policy: 'always', responseMode: 'hands_free' }), false);
        assert.equal(shouldSuppressThinking({ policy: 'always', responseMode: 'text' }), false);

        assert.equal(shouldSuppressThinking({ policy: 'never', responseMode: 'voice' }), true);
        assert.equal(shouldSuppressThinking({ policy: 'never', responseMode: 'hands_free' }), true);
        assert.equal(shouldSuppressThinking({ policy: 'never', responseMode: 'text' }), true);
    });

    it('a malformed stored policy never suppresses a text turn', () => {
        assert.equal(shouldSuppressThinking({ policy: {}, responseMode: 'text' }), false);
        assert.equal(shouldSuppressThinking({ policy: {}, responseMode: 'voice' }), true);
    });
});
