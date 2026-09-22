import assert from 'node:assert/strict';
import test from 'node:test';
import {
    estimateTokens,
    estimatePromptTokens,
    applyPromptBudget,
    DEFAULT_MAX_PROMPT_TOKENS,
    DEFAULT_GENERATION_RESERVE_TOKENS,
} from '../../src/openparlor/prompt-budget.js';

test('estimateTokens estimates ceil(chars/4) and is safe for non-strings', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens(null), 0);
    assert.equal(estimateTokens(undefined), 0);
    assert.equal(estimateTokens(42), 0);
    assert.equal(estimateTokens('abcd'), 1);
    assert.equal(estimateTokens('abcde'), 2);
    assert.equal(estimateTokens('a'.repeat(800)), 200);
});

test('estimatePromptTokens sums message content with per-message overhead', () => {
    const messages = [
        { role: 'system', content: 'a'.repeat(40) },
        { role: 'user', content: 'b'.repeat(8) },
    ];
    assert.equal(estimatePromptTokens(messages), 10 + 4 + 2 + 4);
    assert.equal(estimatePromptTokens([]), 0);
    assert.equal(estimatePromptTokens([null, { role: 'user' }]), 4);
});

test('applyPromptBudget returns the same content when already within budget', () => {
    const messages = [
        { role: 'system', content: 'persona' },
        { role: 'user', content: 'old' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'newest' },
    ];
    const result = applyPromptBudget(messages, { maxPromptTokens: 1000, generationReserveTokens: 100 });
    assert.deepEqual(result, messages);
    assert.notEqual(result, messages, 'must return a new array, not mutate the caller');
});

test('applyPromptBudget trims oldest history until the prompt fits the budget', () => {
    // 4000 chars = 1000 tokens per message; reserve leaves 900 tokens of room.
    const big = 'x'.repeat(4000);
    const messages = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: big },
        { role: 'assistant', content: big },
        { role: 'user', content: big },
        { role: 'assistant', content: big },
        { role: 'user', content: 'newest turn' },
    ];
    const result = applyPromptBudget(messages, { maxPromptTokens: 2000, generationReserveTokens: 200 });
    // limit = 1800 tokens; each big message is 1004 tokens => at most one big message kept.
    assert.deepEqual(result[0], messages[0], 'system message is never dropped');
    assert.equal(result[result.length - 1].content, 'newest turn', 'newest user turn is never dropped');
    assert.ok(estimatePromptTokens(result) <= 1800);
    // The single most recent history message is kept; older history is dropped.
    assert.equal(result.length, 3);
    assert.equal(result[1].role, 'assistant');
    assert.equal(result[1].content, big);
    assert.equal(result[2].content, 'newest turn');
});

test('applyPromptBudget never drops the newest user turn even when only system and it remain', () => {
    const huge = 'y'.repeat(40000);
    const messages = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: huge },
    ];
    const result = applyPromptBudget(messages, { maxPromptTokens: 100, generationReserveTokens: 10 });
    assert.deepEqual(result, messages, 'nothing is trimmable: system and newest user turn stay');
});

test('applyPromptBudget handles non-array and system-less inputs safely', () => {
    assert.deepEqual(applyPromptBudget(null), []);
    assert.deepEqual(applyPromptBudget('nope'), []);
    const noSystem = [
        { role: 'user', content: 'a'.repeat(8000) },
        { role: 'user', content: 'last' },
    ];
    const result = applyPromptBudget(noSystem, { maxPromptTokens: 100, generationReserveTokens: 10 });
    assert.equal(result[result.length - 1].content, 'last');
    assert.ok(estimatePromptTokens(result) <= 90);
});

test('defaults keep a full prompt plus reserve under a 4096-token context', () => {
    assert.ok(DEFAULT_MAX_PROMPT_TOKENS - DEFAULT_GENERATION_RESERVE_TOKENS > 0);
    assert.ok(DEFAULT_MAX_PROMPT_TOKENS <= 4096, 'default prompt cap must fit a 4096 context with reserve');
    const big = 'x'.repeat(4000);
    const messages = [
        { role: 'system', content: 's'.repeat(8000) }, // 2004 tokens
        { role: 'user', content: big },
        { role: 'assistant', content: big },
        { role: 'user', content: big },
        { role: 'assistant', content: big },
        { role: 'user', content: 'newest' },
    ];
    const result = applyPromptBudget(messages);
    assert.ok(estimatePromptTokens(result) + DEFAULT_GENERATION_RESERVE_TOKENS <= DEFAULT_MAX_PROMPT_TOKENS);
});
