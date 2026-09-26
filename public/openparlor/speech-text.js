/**
 * Speech text preparation (VOICE-005).
 *
 * The displayed chat text can stay as rich as the model likes: bold, lists,
 * links, code. None of that survives a speech synthesizer, and several things
 * a model emits must never be spoken AT ALL.
 *
 * This module is the single boundary between the two. Everything here is a
 * pure function over a string so it can be tested without a browser, and so
 * the same rules apply to the text-to-speech path no matter who calls it.
 *
 * The order below is load-bearing and is explained at each step.
 */

/**
 * Blocks that carry hidden reasoning or internal metadata rather than speech.
 *
 * Models that emit visible reasoning do so inside tags. A synthesizer that
 * reads them aloud is the worst possible outcome: the user hears the model
 * thinking about how to answer, and long deliberation blocks have no natural
 * sentence boundaries, so they can also stall the streaming splitter.
 */
const REASONING_BLOCK_PATTERNS = [
    /<think>[\s\S]*?<\/think>/gi,
    /<thinking>[\s\S]*?<\/thinking>/gi,
    /<reflection>[\s\S]*?<\/reflection>/gi,
    /<scratchpad>[\s\S]*?<\/scratchpad>/gi,
    /<internal>[\s\S]*?<\/internal>/gi,
    /<analysis>[\s\S]*?<\/analysis>/gi,
];

/**
 * An UNCLOSED reasoning tag is worse than a closed one: the regular
 * expression above will not match, and everything after it would be read
 * aloud. This removes the remainder of the message instead.
 */
const UNCLOSED_REASONING_PATTERN = /<(think|thinking|reflection|scratchpad|internal|analysis)\b[^>]*>[\s\S]*$/i;

/** Fenced code blocks. Code has no business being narrated. */
const CODE_FENCE_PATTERN = /(^|\n)[ \t]*(```|~~~)[\s\S]*?\2[ \t]*(?=\n|$)/g;
/** An unterminated fence (truncated stream) runs to the end of the text. */
const UNCLOSED_CODE_FENCE_PATTERN = /(^|\n)[ \t]*(```|~~~)[\s\S]*$/;

/** Images carry no speech; the alt text of a decorative image is noise. */
const IMAGE_PATTERN = /!\[[^\]]*\]\([^)]*\)/g;
/** Links keep their label, never their target. */
const LINK_PATTERN = /\[([^\]]+)\]\([^)]*\)/g;
/** Bare URLs, including bare www. and protocol-relative forms. */
const BARE_URL_PATTERN = /\b(?:https?:\/\/|www\.)\S+/gi;

/**
 * Removes hidden reasoning and internal metadata.
 * @param {string} text
 * @returns {string}
 */
function stripReasoning(text) {
    let out = text;
    for (const pattern of REASONING_BLOCK_PATTERNS) {
        out = out.replace(pattern, ' ');
    }
    return out.replace(UNCLOSED_REASONING_PATTERN, ' ');
}

/**
 * Removes code blocks, including a fence left open by a truncated stream.
 * @param {string} text
 * @returns {string}
 */
function stripCode(text) {
    return text
        .replace(CODE_FENCE_PATTERN, '\n')
        .replace(UNCLOSED_CODE_FENCE_PATTERN, '\n');
}

/**
 * Converts link syntax to something speakable: images vanish, links keep
 * their label, bare URLs are dropped.
 * @param {string} text
 * @returns {string}
 */
function stripLinks(text) {
    return text
        .replace(IMAGE_PATTERN, ' ')
        .replace(LINK_PATTERN, '$1')
        .replace(BARE_URL_PATTERN, ' ');
}

/**
 * Removes markdown decoration while keeping the words.
 *
 * The emphasis patterns deliberately require a non-word boundary on the outer
 * edge. Without that, `snake_case_name` and `2 * 3 * 4` would be mangled into
 * `snakecasename` and `2 3 4` — a corruption bug, not a formatting cleanup.
 *
 * @param {string} text
 * @returns {string}
 */
function stripMarkup(text) {
    return text
        // Inline code: keep the code's words, drop the backticks.
        .replace(/`([^`\n]+)`/g, '$1')
        // Bold/italic, longest delimiter first so ** is not left as a stray *.
        .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        // The emphasis content must not begin or end with whitespace. That is
        // what markdown itself requires, and it is what separates real emphasis
        // from arithmetic: "and *italic* here" is emphasis, "2 * 3 * 4 = 24"
        // is multiplication. A looser rule silently turned the second into
        // "2 3 4 = 24".
        .replace(/\*([^\s*][^*\n]*[^\s*]|[^\s*])\*/g, '$1')
        .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s.,!?;:)\]])/g, '$1$2')
        .replace(/~~([^~]+)~~/g, '$1');
}

/**
 * Removes line-level markdown markers: headings, block quotes, list bullets,
 * horizontal rules, and table pipes.
 * @param {string} text
 * @returns {string}
 */
function stripLineMarkers(text) {
    return text
        .replace(/^[ \t]*#{1,6}[ \t]*/gm, '')
        .replace(/^[ \t]*>[ \t]?/gm, '')
        // Ordered and unordered list markers. The trailing space is optional
        // so a tight "-item" is cleaned too, but the marker must be followed by
        // a boundary so a leading minus in "-5 degrees" is left alone.
        .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, '')
        .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '')
        .replace(/\|/g, ' ');
}

/**
 * Collapses runs of whitespace so the result reads as one continuous utterance.
 * Paragraph and list breaks become sentence breaks, because a newline is
 * never a pause a synthesizer can use.
 * @param {string} text
 * @returns {string}
 */
function collapseWhitespace(text) {
    return text
        .replace(/\s*\n+\s*/g, '. ')
        .replace(/\s+/g, ' ')
        // A newline-joined list becomes "item. item." rather than "item item."
        .replace(/\.\s*\./g, '.')
        .trim();
}

/**
 * Prepares a character reply to be spoken.
 *
 * Returns '' for input that is entirely non-speech (an image, a code block, a
 * reasoning block), which callers must treat as "nothing to say" rather than
 * synthesizing an empty clip.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function toSpeechText(text) {
    if (typeof text !== 'string' || text.trim() === '') return '';
    let out = text;
    out = stripReasoning(out);
    out = stripCode(out);
    out = stripLinks(out);
    out = stripMarkup(out);
    out = stripLineMarkers(out);
    out = collapseWhitespace(out);
    // A message that was nothing but an image, a code block, or a reasoning
    // block has no speakable content left. Callers must treat that as "nothing
    // to say" rather than synthesizing a clip of stray punctuation.
    if (!/[\p{L}\p{N}]/u.test(out)) return '';
    return out.trim();
}
