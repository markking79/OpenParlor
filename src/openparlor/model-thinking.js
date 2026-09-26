/**
 * Thinking policy for reasoning models.
 *
 * A reasoning model streams a `reasoning_content` phase before its first
 * visible token. OpenParlor renders only `content`, so that phase is invisible
 * — and on the local Qwen stack it measured 20-60 seconds per turn.
 *
 * That cost is not the same in every medium, which is why this is a policy and
 * not a switch:
 *
 * - A SPOKEN turn (voice / hands-free) is a conversation. The user has just
 *   finished talking and is waiting for the answer to be spoken; a minute of
 *   silence reads as a broken app, and in hands-free the user talks over it and
 *   the turn is lost. So the thinking phase is suppressed there.
 * - A TEXT turn is not. The browser already shows a first-token progress
 *   estimate, so a long wait is legible rather than mysterious — and a hard
 *   question ("solve this integral") genuinely needs the reasoning. Suppressing
 *   it would make the model look stupid for the sake of a latency nobody is
 *   waiting on.
 *
 * The policy lets a deployment override that judgement in either direction.
 */

import { isSpokenMode, normalizeResponseMode } from './response-style.js';

/** Thinking policies. Anything else is treated as 'auto'. */
export const THINKING_POLICIES = ['auto', 'always', 'never'];

const DEFAULT_POLICY = 'auto';

/**
 * Coerces a stored/user-supplied thinking policy to a known value.
 *
 * @param {unknown} raw
 * @returns {'auto'|'always'|'never'}
 */
export function normalizeThinkingPolicy(raw) {
    return typeof raw === 'string' && THINKING_POLICIES.includes(raw) ? raw : DEFAULT_POLICY;
}

/**
 * Decides whether this turn should run with the thinking phase suppressed.
 *
 * @param {{ policy?: unknown, responseMode?: unknown }} [params]
 * @param {unknown} [params.policy] Stored `model.thinking` policy
 * @param {unknown} [params.responseMode] Delivery medium for THIS turn
 * @returns {boolean} True when the turn must not be allowed to think first
 */
export function shouldSuppressThinking({ policy, responseMode } = {}) {
    switch (normalizeThinkingPolicy(policy)) {
        // The deployment always wants the model's full reasoning.
        case 'always':
            return false;
        // The deployment always wants the fastest possible turn.
        case 'never':
            return true;
        // Spoken turns cannot absorb an invisible wait; text turns can.
        default:
            return isSpokenMode(normalizeResponseMode(responseMode));
    }
}
