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
 * Selects which character participant(s) should respond to a user message.
 * Deterministic: the same inputs always produce the same output.
 *
 * Selection rules:
 * 1. If there are no character participants, return an empty array.
 * 2. If there is exactly one character participant, return it.
 * 3. If the user message directly mentions one or more character names
 *    (case-insensitive, word-boundary match), return those participants.
 * 4. Otherwise, return the first character participant (deterministic by order).
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

    const nameMap = new Map();
    for (const char of characters) {
        nameMap.set(char.id, char.name);
    }

    const messageLower = userMessage.toLowerCase();
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
