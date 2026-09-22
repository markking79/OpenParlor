/**
 * @typedef {Object} CharacterParticipant
 * @property {string} id Participant ID
 * @property {string} character_id Character ID
 * @property {string} role Role in the conversation
 */

/**
 * @typedef {Object} Character
 * @property {string} id Character ID
 * @property {string} name Character display name
 */

/**
 * Escapes special regex characters in a string.
 * @param {string} str The string to escape
 * @returns {string} The escaped string
 */
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Bounded whole-group cues, matched against the lowercased message.
 */
const GROUP_WIDE_CUES = [
    /\beveryone\b/,
    /\beverybody\b/,
    /\ball of you\b/,
    /\byou all\b/,
];

// Two-person cues, honored only when exactly two character participants exist.
// /\bboth\b/ also covers "both of you" and "you both".
const TWO_PERSON_CUES = [
    /\bboth\b/,
    /\byou two\b/,
];

/**
 * Reports whether the user message contains a whole-group intent cue.
 *
 * @param {string} messageLower Lowercased user message
 * @param {number} characterCount Number of character participants
 * @returns {boolean}
 */
function hasWholeGroupCue(messageLower, characterCount) {
    if (GROUP_WIDE_CUES.some(cue => cue.test(messageLower))) {
        return true;
    }
    return characterCount === 2 && TWO_PERSON_CUES.some(cue => cue.test(messageLower));
}

/**
 * Selects which character participant(s) should respond to a user message.
 * Deterministic: the same inputs always produce the same output.
 *
 * Selection rules (first match wins):
 * 1. If there are no character participants, return an empty array.
 * 2. If there is exactly one character participant, return it.
 * 3. If the user message contains a whole-group cue ("everyone", "both of
 *    you", …), return all character participants in participant order.
 * 4. If the user message directly mentions one or more character names
 *    (case-insensitive, word-boundary match), return those participants.
 * 5. Otherwise, return the first character participant (deterministic by order).
 *
 * @param {CharacterParticipant[]} participants All participants in the conversation
 * @param {Character[]} characters Character records corresponding to the participants
 * @param {string} userMessage The user's message content
 * @returns {CharacterParticipant[]} The selected character participants (non-empty when character participants exist)
 */
export function selectSpeaker(participants, characters, userMessage) {
    const charParticipants = participants.filter(p => p.role === 'character');
    if (charParticipants.length === 0 || typeof userMessage !== 'string' || userMessage.trim() === '') {
        return [];
    }
    if (charParticipants.length === 1) {
        return charParticipants;
    }

    const messageLower = userMessage.toLowerCase();
    if (hasWholeGroupCue(messageLower, charParticipants.length)) {
        return charParticipants;
    }

    const nameMap = new Map();
    for (const char of characters) {
        nameMap.set(char.id, char.name);
    }

    const mentioned = charParticipants.filter(p => {
        const name = nameMap.get(p.character_id);
        if (!name || typeof name !== 'string' || name === '') {
            return false;
        }
        const pattern = `\\b${escapeRegex(name.toLowerCase())}\\b`;
        return new RegExp(pattern).test(messageLower);
    });

    if (mentioned.length > 0) {
        return mentioned;
    }

    return [charParticipants[0]];
}
