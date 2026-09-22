/**
 * Prompt token budgeting for OpenParlor.
 *
 * The local llama.cpp context is fixed-size, so the assembled prompt must
 * never exceed it once the generation reserve is accounted for. This module
 * provides a conservative character-based token estimate and a bounded trim
 * that only ever drops the oldest history messages. The system prompt
 * (persona, memories, summary) and the newest user turn are never dropped.
 */

// Conservative estimate: English text with a typical tokenizer averages at
// least ~4 characters per token. Overestimating is safe (trims earlier),
// underestimating would risk overflowing the context.
const TOKENS_PER_CHAR = 4;
// Per-message overhead (role, separators, chat template tokens).
const MESSAGE_OVERHEAD_TOKENS = 4;

// A 4096-token context is the most common conservative llama.cpp default;
// keeping the prompt at 4096 - 512 leaves a 512-token generation reserve so
// a request can never unexpectedly exceed the context window.
const DEFAULT_MAX_PROMPT_TOKENS = 4096;
const DEFAULT_GENERATION_RESERVE_TOKENS = 512;

/**
 * Estimates the token count of a single text value.
 * @param {unknown} text
 * @returns {number} Estimated token count (0 for non-strings)
 */
export function estimateTokens(text) {
    if (typeof text !== 'string' || text === '') return 0;
    return Math.ceil(text.length / TOKENS_PER_CHAR);
}

/**
 * Estimates the token count of one chat message including per-message overhead.
 * @param {unknown} message
 * @returns {number}
 */
export function estimateMessageTokens(message) {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) return 0;
    return estimateTokens(/** @type {{ content?: unknown }} */ (message).content) + MESSAGE_OVERHEAD_TOKENS;
}

/**
 * Estimates the total token count of an assembled prompt.
 * @param {unknown} messages
 * @returns {number}
 */
export function estimatePromptTokens(messages) {
    if (!Array.isArray(messages)) return 0;
    let total = 0;
    for (const message of messages) {
        total += estimateMessageTokens(message);
    }
    return total;
}

/**
 * Trims the oldest trimmable messages until the prompt fits the budget.
 *
 * Protected from trimming:
 * - the first message when it is the system prompt (persona/memory/summary);
 * - the newest user message (the current turn, which must appear exactly once).
 *
 * Everything between them is history and is dropped from the oldest first.
 * The input array is never mutated; a new array is returned.
 *
 * @param {unknown} messages Assembled prompt messages (system first, newest last)
 * @param {{ maxPromptTokens?: number, generationReserveTokens?: number }} [options]
 *   Budget in estimated tokens. The prompt must fit within
 *   `maxPromptTokens - generationReserveTokens` so that prompt plus the
 *   reserved generation tokens stay inside the model context.
 * @returns {Array<{ role: string, content: string }>} Bounded prompt messages
 */
export function applyPromptBudget(messages, {
    maxPromptTokens = DEFAULT_MAX_PROMPT_TOKENS,
    generationReserveTokens = DEFAULT_GENERATION_RESERVE_TOKENS,
} = {}) {
    if (!Array.isArray(messages) || messages.length === 0) return [];
    const max = Number.isFinite(maxPromptTokens) && maxPromptTokens > 0 ? maxPromptTokens : DEFAULT_MAX_PROMPT_TOKENS;
    const reserve = Number.isFinite(generationReserveTokens) && generationReserveTokens >= 0
        ? generationReserveTokens
        : DEFAULT_GENERATION_RESERVE_TOKENS;
    const limit = Math.max(1, max - reserve);

    const result = messages.map(m => ({ ...m }));
    if (estimatePromptTokens(result) <= limit) return result;

    // Newest user message is the current turn and is always protected.
    let lastUser = -1;
    for (let i = result.length - 1; i >= 0; i--) {
        if (result[i] && result[i].role === 'user') {
            lastUser = i;
            break;
        }
    }

    const start = (result[0] && result[0].role === 'system') ? 1 : 0;
    let end = lastUser >= 0 ? lastUser : result.length;
    let i = start;
    while (estimatePromptTokens(result) > limit && i < end) {
        result.splice(i, 1);
        if (lastUser >= 0) lastUser--;
        end = lastUser >= 0 ? lastUser : result.length;
    }
    return result;
}

export { DEFAULT_MAX_PROMPT_TOKENS, DEFAULT_GENERATION_RESERVE_TOKENS };
