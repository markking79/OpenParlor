import * as persistence from './persistence.js';

const MAX_RETRIEVED_MEMORIES = 10;
const MAX_MEMORY_PROMPT_CHARS = 2000;

/**
 * Tokenizes a string into lowercase alphanumeric tokens.
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
    return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Computes a simple relevance score: count of unique query tokens found in content.
 * @param {string} query
 * @param {string} content
 * @returns {number}
 */
function relevanceScore(query, content) {
    const queryTokens = new Set(tokenize(query));
    if (queryTokens.size === 0) return 0;
    const contentTokens = new Set(tokenize(content));
    let score = 0;
    for (const token of queryTokens) {
        if (contentTokens.has(token)) score++;
    }
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

    const scored = memories.filter(mem => mem.active).map(mem => ({
        mem,
        score: relevanceScore(query, mem.content),
    }));

    const relevant = scored.filter(s => s.score > 0);
    relevant.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (b.mem.importance !== a.mem.importance) return b.mem.importance - a.mem.importance;
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
