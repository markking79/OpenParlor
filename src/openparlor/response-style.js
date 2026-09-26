/**
 * Response style policy (VOICE-005).
 *
 * Streaming TTS solved the latency problem. The next question is whether a
 * reply sounds like CONVERSATION or like an essay being read aloud. This
 * module is the single place that answers it, and it does so purely as prompt
 * POLICY: the model is told how to shape delivery for the current medium.
 *
 * Two deliberate constraints:
 *
 *  1. Text chat is never degraded. `buildResponseStyleGuidance` returns ''
 *     for the text mode, so a text-only conversation receives a byte-identical
 *     system prompt. Only a medium that is actually spoken gets voice
 *     guidance.
 *
 *  2. The character stays authoritative. These rules shape HOW a character
 *     speaks, never WHO they are. A character's persona, scenario, and voice
 *     outrank anything here, and the guidance says so explicitly, because a
 *     rule like "be brief" is exactly the kind of instruction a model will
 *     happily apply to a character's defining traits if left unqualified.
 */

/** Response mediums. Anything else is treated as 'text'. */
export const RESPONSE_MODES = ['text', 'voice', 'hands_free'];

/** User preference for how much a spoken reply should say. */
export const VOICE_RESPONSE_LENGTHS = ['concise', 'normal', 'detailed'];

const DEFAULT_MODE = 'text';
const DEFAULT_LENGTH = 'normal';

/**
 * Coerces a client-supplied response mode to a known value.
 *
 * The value arrives from the browser, so it is untrusted input: an unknown or
 * missing mode must fall back to text, which is the safe default because it
 * changes no existing behaviour.
 *
 * @param {unknown} raw
 * @returns {'text'|'voice'|'hands_free'}
 */
export function normalizeResponseMode(raw) {
    return typeof raw === 'string' && RESPONSE_MODES.includes(raw) ? raw : DEFAULT_MODE;
}

/**
 * Coerces a stored/user-supplied voice length preference to a known value.
 * @param {unknown} raw
 * @returns {'concise'|'normal'|'detailed'}
 */
export function normalizeVoiceResponseLength(raw) {
    return typeof raw === 'string' && VOICE_RESPONSE_LENGTHS.includes(raw)
        ? raw
        : DEFAULT_LENGTH;
}

/**
 * True when the medium is actually spoken and therefore wants voice shaping.
 * Hands-free counts: it is spoken, and read aloud a long reply is worse
 * there than in voice mode because the user is mid-conversation rather than
 * reading the transcript.
 *
 * @param {unknown} mode
 * @returns {boolean}
 */
export function isSpokenMode(mode) {
    return mode === 'voice' || mode === 'hands_free';
}

const LENGTH_GUIDANCE = {
    concise: 'Keep it to one or two sentences unless the user asks for more.',
    normal: 'Answer in a short paragraph or two.',
    detailed: 'You may elaborate when there is genuinely something to say, but stay conversational rather than essayistic.',
};

/**
 * Builds the response-style guidance for a turn.
 *
 * Returns an empty string for text mode, which is what keeps text chat
 * unchanged: the caller appends the result unconditionally and nothing is
 * added when the medium is not spoken.
 *
 * @param {object} params
 * @param {unknown} params.mode Response medium for THIS turn
 * @param {unknown} params.length User's spoken-length preference
 * @returns {string} Guidance text, or '' when none applies
 */
export function buildResponseStyleGuidance({ mode, length } = {}) {
    const normalizedMode = normalizeResponseMode(mode);
    if (!isSpokenMode(normalizedMode)) return '';
    const normalizedLength = normalizeVoiceResponseLength(length);

    return [
        'Your reply will be read aloud by a speech synthesizer, not displayed as an essay.',
        'This changes delivery ONLY. Everything above about who you are, your personality, your relationships, and your speaking style still outranks these notes.',
        'Speak the way people actually talk:',
        '- Keep turns short. One idea per turn, and stop when you have said it.',
        '- Use contractions (I\'m, don\'t, it\'ll). Nobody says "I do not".',
        '- Prefer plain phrasing over formal or literary phrasing.',
        '- Skip markdown entirely. No bold, no italics, no headers, no bullet lists, none of it will be readable out loud.',
        '- Avoid long parentheticals and asides; say the main thing and stop.',
        '- Do not restate or summarise what you just said.',
        '- Do not open with filler like "Great question" or "Certainly".',
        LENGTH_GUIDANCE[normalizedLength],
    ].join('\n');
}
