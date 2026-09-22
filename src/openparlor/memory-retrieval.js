import * as persistence from './persistence.js';
import {
    significantTokens,
    significantSequence,
    uniqueSignificantSequence,
    properNounStems,
} from './memory-text.js';

const MAX_RETRIEVED_MEMORIES = 10;
const MAX_MEMORY_PROMPT_CHARS = 2000;

// Scoring weights (kept deliberately simple and explainable).
const PROPER_NOUN_MATCH_WEIGHT = 1.5;
const PROPER_NOUN_MISMATCH_WEIGHT = 1.0;
const PHRASE_COVERAGE_BONUS = 1.0;
const MAX_BIGRAM_BONUS = 1.0;
const IMPORTANCE_CONFIDENCE_WEIGHT = 0.25;
const RECENCY_WEIGHT = 0.1;
const PINNED_BONUS = 1.0;
const RECENCY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Computes a token-overlap relevance score between a query and memory content.
 *
 * Components:
 * - Each significant query token found in the content scores 1.0; tokens that
 *   are proper nouns in both the query and the content score 1.5.
 * - If every significant query token matches, a full-phrase coverage bonus is
 *   added (exact/near-exact matches should outrank partial ones).
 * - Consecutive query bigrams that appear adjacent in the content add up to
 *   MAX_BIGRAM_BONUS (phrase-adjacency signal, capped).
 *
 * @param {string} query
 * @param {string} content
 * @returns {number}
 */
function relevanceScore(query, content) {
    const querySeq = uniqueSignificantSequence(query);
    if (querySeq.length === 0) return 0;
    const contentTokens = significantTokens(content);
    const contentSeq = significantSequence(content);
    const queryProper = properNounStems(query);
    const contentProper = properNounStems(content);
    if (contentTokens.size === 0) return 0;

    let score = 0;
    let matched = 0;
    for (const token of querySeq) {
        if (!contentTokens.has(token)) continue;
        matched++;
        const isProperMatch = queryProper.has(token) && contentProper.has(token);
        score += isProperMatch ? PROPER_NOUN_MATCH_WEIGHT : PROPER_NOUN_MISMATCH_WEIGHT;
    }
    if (matched === 0) return 0;

    if (matched === querySeq.length) {
        score += PHRASE_COVERAGE_BONUS;
    }

    let bigramBonus = 0;
    for (let i = 0; i < querySeq.length - 1 && bigramBonus < MAX_BIGRAM_BONUS; i++) {
        const a = querySeq[i];
        const b = querySeq[i + 1];
        for (let j = 0; j < contentSeq.length - 1; j++) {
            if (contentSeq[j] === a && contentSeq[j + 1] === b) {
                bigramBonus += 0.5;
                break;
            }
        }
    }
    score += Math.min(bigramBonus, MAX_BIGRAM_BONUS);

    return score;
}

/**
 * Sanitizes untrusted memory content to prevent delimiter forgery.
 * Replaces any occurrence of the memory section delimiters with a safe marker.
 * @param {string} content
 * @returns {string}
 */
function sanitizeMemoryContent(content) {
    return content.replaceAll('[', '(').replaceAll(']', ')').replace(/[\r\n]+/g, ' ');
}

/**
 * Retrieves and ranks active memories visible to a character, bounded by count
 * and total prompt size. Returns formatted lines suitable for prompt injection.
 *
 * Ranking: token-overlap relevance (with proper-noun, phrase-coverage and
 * bigram bonuses) dominates; importance + confidence and recency break
 * near-ties; pinned memories receive a flat boost.
 *
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} owner_id
 * @param {string} character_id
 * @param {string} query The newest user message to rank against
 * @returns {string[]} Formatted memory lines (may be empty)
 */
export function retrieveMemories(directories, owner_id, character_id, query) {
    if (!query || typeof query !== 'string' || query.trim() === '') {
        return [];
    }
    const memories = persistence.listMemories(directories, owner_id, character_id);
    if (memories.length === 0) return [];
    const now = Date.now();

    const scored = memories.filter(mem => mem.active).map(mem => {
        const relevance = relevanceScore(query, mem.content);
        if (relevance <= 0) return { mem, score: 0 };
        const importance = Number.isFinite(mem.importance) ? mem.importance : 0.5;
        const confidence = Number.isFinite(mem.confidence) ? mem.confidence : 0.5;
        const createdMs = Number.isFinite(Date.parse(mem.created_at)) ? Date.parse(mem.created_at) : now;
        const ageMs = Math.max(0, now - createdMs);
        const recency = Math.exp(-ageMs / RECENCY_HALF_LIFE_MS);
        const pinnedBoost = mem.pinned ? PINNED_BONUS : 0;
        const score = relevance
            + IMPORTANCE_CONFIDENCE_WEIGHT * ((importance + confidence) / 2)
            + RECENCY_WEIGHT * recency
            + pinnedBoost;
        return { mem, score };
    });

    const relevant = scored.filter(s => s.score > 0);
    relevant.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const ta = Number.isFinite(Date.parse(a.mem.created_at)) ? Date.parse(a.mem.created_at) : 0;
        const tb = Number.isFinite(Date.parse(b.mem.created_at)) ? Date.parse(b.mem.created_at) : 0;
        if (tb !== ta) return tb - ta;
        return a.mem.id.localeCompare(b.mem.id);
    });

    const lines = [];
    let totalChars = 0;
    for (const { mem } of relevant) {
        if (lines.length >= MAX_RETRIEVED_MEMORIES) break;
        const line = `- ${mem.type}: ${sanitizeMemoryContent(mem.content)}`;
        if (totalChars + line.length > MAX_MEMORY_PROMPT_CHARS) continue;
        lines.push(line);
        totalChars += line.length;
    }

    return lines;
}

export { MAX_RETRIEVED_MEMORIES, MAX_MEMORY_PROMPT_CHARS };
