/**
 * Shared lightweight text utilities for OpenParlor memory deduplication and
 * retrieval. These are intentionally simple and deterministic: no external
 * NLP dependencies, and every transformation is applied symmetrically to
 * queries and memory content so imperfect stems never produce false matches.
 */

/**
 * Common English stopwords (plus contraction fragments produced by the
 * tokenizer) that carry no topical signal for memory retrieval. Note that
 * "user" is deliberately NOT a stopword: memory content uses it as the
 * primary entity reference.
 */
const STOPWORDS = new Set([
    'i', 'me', 'my', 'myself', 'we', 'us', 'our', 'ours', 'ourselves',
    'you', 'your', 'yours', 'yourself', 'yourselves',
    'he', 'him', 'his', 'himself', 'she', 'her', 'hers', 'herself',
    'it', 'its', 'itself', 'they', 'them', 'their', 'theirs', 'themselves',
    'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those',
    'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'having', 'do', 'does', 'did', 'doing',
    'a', 'an', 'the', 'and', 'but', 'if', 'or', 'because', 'as', 'until',
    'while', 'of', 'at', 'by', 'for', 'with', 'about', 'against', 'between',
    'through', 'during', 'before', 'after', 'above', 'below', 'to', 'from',
    'up', 'down', 'in', 'out', 'on', 'off', 'over', 'under', 'again',
    'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why', 'how',
    'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some',
    'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too',
    'very', 'can', 'will', 'just', 'should', 'could', 'would', 'might',
    'must', 'now',
    // contraction fragments: "user's" tokenizes to ["user", "s"]
    's', 't', 'd', 'll', 'm', 'o', 're', 've', 'y',
]);

/**
 * Tokenizes a string into lowercase alphanumeric tokens.
 * @param {unknown} text
 * @returns {string[]}
 */
export function tokenize(text) {
    if (typeof text !== 'string') return [];
    return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Conservative suffix stemmer. Only strips unambiguous endings and only
 * when the remainder is long enough to be meaningful. Both sides of a
 * comparison (query and content) use the same stemmer, so a wrong stem
 * degrades to a miss, never a false positive.
 * @param {string} token
 * @returns {string}
 */
export function lightStem(token) {
    if (typeof token !== 'string' || token.length < 4) return token;
    if (token.endsWith('ies') && token.length >= 5) {
        return token.slice(0, -3) + 'y';
    }
    if (token.endsWith('ing') && token.length >= 6) {
        const stem = token.slice(0, -3);
        if (stem.length >= 3) return stem;
    }
    if (token.endsWith('ed') && token.length >= 5) {
        if (token.endsWith('eed')) {
            // "needed" -> "need", "agreed" -> "agree"
            const stem = token.slice(0, -1);
            if (stem.length >= 3) return stem;
        }
        const stem = token.slice(0, -2);
        if (stem.length >= 3) {
            // "loved" -> "lov": a single trailing consonant after a vowel
            // usually means the base word ended in "e" (love + d).
            const last = stem.length - 1;
            if (last >= 2 && /[aeiou]/.test(stem[last - 1]) && !/[aeiou]/.test(stem[last])) {
                return stem + 'e';
            }
            return stem;
        }
    }
    // "es" is only a suffix after a consonant ("dishes" -> "dish",
    // "boxes" -> "box"). After a vowel the word ends in a plain "s"
    // ("likes"), except the "-ees" plural which loses just the "s".
    if (token.endsWith('es') && token.length >= 4 && !token.endsWith('ses')) {
        const before = token[token.length - 3] ?? '';
        if (/[aeiou]/.test(before)) {
            if (token.endsWith('ees')) {
                const stem = token.slice(0, -1); // "coffees" -> "coffee"
                if (stem.length >= 3) return stem;
            }
            return token; // "likes"
        }
        const stem = token.slice(0, -2);
        if (stem.length >= 3) return stem;
    }
    // "ss"/"us"/"is" endings are left alone. A bare "s" after a vowel is kept
    // to avoid mangling proper nouns (e.g. "paris", "texas").
    if (token.endsWith('s') && !token.endsWith('ss') && !token.endsWith('us') && !token.endsWith('is')) {
        const before = token[token.length - 2] ?? '';
        if (/[aeiou]/.test(before)) return token;
        const stem = token.slice(0, -1);
        if (stem.length >= 3) return stem;
    }
    if (token.endsWith('ly')) {
        let stem = token.slice(0, -2);
        if (stem.endsWith('i')) stem = stem.slice(0, -1) + 'y';
        if (stem.length >= 3) return stem;
    }
    return token;
}

/**
 * Returns the set of significant (stopword-filtered, stemmed) tokens.
 * @param {unknown} text
 * @returns {Set<string>}
 */
export function significantTokens(text) {
    const set = new Set();
    for (const token of tokenize(text)) {
        if (STOPWORDS.has(token)) continue;
        set.add(lightStem(token));
    }
    return set;
}

/**
 * Returns significant tokens in original order (no de-duplication).
 * @param {unknown} text
 * @returns {string[]}
 */
export function significantSequence(text) {
    const seq = [];
    for (const token of tokenize(text)) {
        if (STOPWORDS.has(token)) continue;
        seq.push(lightStem(token));
    }
    return seq;
}

/**
 * Returns significant tokens in first-occurrence order, duplicates removed.
 * @param {unknown} text
 * @returns {string[]}
 */
export function uniqueSignificantSequence(text) {
    const seen = new Set();
    const seq = [];
    for (const stem of significantSequence(text)) {
        if (seen.has(stem)) continue;
        seen.add(stem);
        seq.push(stem);
    }
    return seq;
}

/**
 * Returns the set of stems for tokens that appear capitalized in the text.
 * Used to detect proper-name/entity matches between a query and a memory.
 * @param {unknown} text
 * @returns {Set<string>}
 */
export function properNounStems(text) {
    const stems = new Set();
    if (typeof text !== 'string') return stems;
    for (const raw of text.split(/[^A-Za-z0-9]+/)) {
        if (raw.length < 2) continue;
        const first = raw[0];
        if (first < 'A' || first > 'Z') continue;
        stems.add(lightStem(raw.toLowerCase()));
    }
    return stems;
}
