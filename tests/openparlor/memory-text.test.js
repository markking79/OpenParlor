import assert from 'node:assert/strict';
import test from 'node:test';
import {
    tokenize,
    lightStem,
    significantTokens,
    significantSequence,
    uniqueSignificantSequence,
    properNounStems,
} from '../../src/openparlor/memory-text.js';

// ─── tokenize ─────────────────────────────────────────────────────────────────

test('tokenize: lowercases and splits on non-alphanumerics', () => {
    assert.deepEqual(tokenize('Hello, World! 123'), ['hello', 'world', '123']);
    assert.deepEqual(tokenize(''), []);
    assert.deepEqual(tokenize('   '), []);
    assert.deepEqual(tokenize('user\'s coffee'), ['user', 's', 'coffee']);
});

test('tokenize: returns empty array for non-string input', () => {
    assert.deepEqual(tokenize(null), []);
    assert.deepEqual(tokenize(42), []);
});

// ─── lightStem ────────────────────────────────────────────────────────────────

test('lightStem: strips safe suffixes', () => {
    assert.equal(lightStem('drinking'), 'drink');
    assert.equal(lightStem('cooking'), 'cook');
    assert.equal(lightStem('worked'), 'work');
    assert.equal(lightStem('loved'), 'love');
    assert.equal(lightStem('dishes'), 'dish');
    assert.equal(lightStem('boxes'), 'box');
    assert.equal(lightStem('cats'), 'cat');
    assert.equal(lightStem('happily'), 'happy');
    assert.equal(lightStem('carefully'), 'careful');
});

test('lightStem: leaves short and risky words unchanged', () => {
    assert.equal(lightStem('is'), 'is');
    assert.equal(lightStem('the'), 'the');
    assert.equal(lightStem('going'), 'going');
    assert.equal(lightStem('used'), 'used');
    assert.equal(lightStem('paris'), 'paris');
    assert.equal(lightStem('coffee'), 'coffee');
    assert.equal(lightStem('class'), 'class');
    assert.equal(lightStem('bonus'), 'bonus');
});

// ─── significantTokens ────────────────────────────────────────────────────────

test('significantTokens: filters stopwords and stems', () => {
    const tokens = significantTokens('The user was working on a novel');
    assert.ok(tokens.has('user'));
    assert.ok(tokens.has('work'));
    assert.ok(tokens.has('novel'));
    assert.ok(!tokens.has('the'));
    assert.ok(!tokens.has('was'));
    assert.ok(!tokens.has('a'));
});

test('significantTokens: empty for stopword-only input', () => {
    assert.equal(significantTokens('the a an and of').size, 0);
});

// ─── significantSequence / uniqueSignificantSequence ──────────────────────────

test('significantSequence: preserves order and drops stopwords', () => {
    assert.deepEqual(significantSequence('The user was born in Paris'), ['user', 'born', 'paris']);
});

test('uniqueSignificantSequence: removes duplicate stems while preserving first position', () => {
    assert.deepEqual(
        uniqueSignificantSequence('coffee and more coffee'),
        ['coffee'],
    );
});

// ─── properNounStems ──────────────────────────────────────────────────────────

test('properNounStems: collects capitalized tokens', () => {
    const stems = properNounStems('Monica works in Paris');
    assert.ok(stems.has('monica'));
    assert.ok(stems.has('paris'));
    assert.ok(!stems.has('works'));
    assert.ok(!stems.has('in'));
});

test('properNounStems: empty for all-lowercase or non-string input', () => {
    assert.equal(properNounStems('the user likes coffee').size, 0);
    assert.equal(properNounStems(null).size, 0);
});
