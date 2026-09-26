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
 * Detects a question a character asked the USER, in the trailing part of that
 * character's message.
 *
 * Only the final sentence is considered: "I'm Doug, by the way. What's your
 * name?" is a question to the user, while "Doug, what did Monica say? She's
 * always asking me things" is not. Restricting the check to the last sentence
 * means a rhetorical question earlier in a line does not create a pending
 * question that the user is not answering.
 *
 * A direct address to another character in that final sentence disqualifies
 * the turn, because the user is not the addressee: "Monica, did you get the
 * delivery?" is a question for Monica, and the user's next message is far more
 * likely a reply to it than an answer to the asker.
 *
 * @param {string} content A character message
 * @returns {boolean} True when the final sentence is a question to the user
 */
function endsWithQuestionToUser(content) {
    if (typeof content !== 'string') return false;
    const trimmed = content.trim();
    if (trimmed === '' || !trimmed.endsWith('?')) return false;
    // Only the final sentence decides.
    const lastSentence = trimmed.split(/(?<=[.!?])\s+/).pop().trim();
    if (!lastSentence.endsWith('?')) return false;
    // A leading vocative means the question is aimed at another character.
    const vocative = /^[^A-Za-z0-9]*[A-Z][\w'-]*(?:\s+(?:and|&)\s+[A-Z][\w'-]*)*\s*,/;
    return !vocative.test(lastSentence);
}

/**
 * Finds the character participant whose most recent turn left a question
 * outstanding for the user.
 *
 * This is the "pending question" rule: in a group, when a character asks the
 * user something and the user then replies, the reply is an answer to THAT
 * character. Reported case: Doug asked "What's your name?", the user answered
 * "Oh, my name is Mark.", and a different character responded.
 *
 * The scan walks backwards and stops at the first user message: only a
 * question asked after the user's last turn can be the one being answered. A
 * question from an earlier turn is already answered and must not re-capture
 * the speaker, or a character could monopolize the room.
 *
 * @param {CharacterParticipant[]} participants All conversation participants
 * @param {Array<{role: string, participant_id?: string, content?: string}>} [recentMessages] Stored messages, oldest first
 * @returns {CharacterParticipant|null} The participant awaiting an answer, or null
 */
export function findPendingQuestionAsker(participants, recentMessages = []) {
    const charParticipants = (Array.isArray(participants) ? participants : [])
        .filter(p => p && p.role === 'character');
    if (charParticipants.length === 0) return null;
    const byParticipantId = new Map(charParticipants.map(p => [p.id, p]));
    const history = Array.isArray(recentMessages) ? recentMessages : [];
    for (let i = history.length - 1; i >= 0; i -= 1) {
        const message = history[i];
        if (!message || typeof message !== 'object') continue;
        if (message.role === 'user') return null; // older questions are already answered
        if (message.role !== 'character') continue;
        const participant = typeof message.participant_id === 'string'
            ? byParticipantId.get(message.participant_id)
            : undefined;
        if (!participant) continue;
        if (endsWithQuestionToUser(message.content)) return participant;
    }
    return null;
}

/**
 * Bounded whole-group cues, matched against the lowercased message.
 */
const GROUP_WIDE_CUES = [
    /\beveryone\b/,
    /\beverybody\b/,
    /\ball of you\b/,
    /\byou all\b/,
    /\byou guys\b/,
    /\bhey guys\b/,
    /\bhi guys\b/,
    /\bhello guys\b/,
    /\byou folks\b/,
    /\bhey folks\b/,
    /\bhi folks\b/,
    /\bhello folks\b/,
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
 * Reports whether a character name appears in direct-address (vocative)
 * position: the lowercased name, at a word boundary, has a comma somewhere
 * after it in the message (the first comma following the name). This is the
 * classic "Name, ..." signal and also covers comma-terminated address lists
 * ("Doug and Monica, ...") and mid-sentence vocatives ("I think, Doug, ...").
 *
 * A name mentioned as the subject or object of a question ("what did Monica
 * say?") has no following comma and is NOT treated as direct address.
 *
 * @param {string} messageLower Lowercased user message
 * @param {string} nameLower Lowercased character name
 * @returns {boolean}
 */
function isDirectAddress(messageLower, nameLower) {
    const pattern = `\\b${escapeRegex(nameLower)}\\b[^,]*,`;
    return new RegExp(pattern).test(messageLower);
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
 * 4. If the user message directly addresses one or more characters in
 *    vocative position (name followed by a comma, e.g. "Doug, ..." or
 *    "Doug and Monica, ..."), return those participants in participant
 *    order. This takes precedence over names merely mentioned in the
 *    message, so "Doug, what did Monica say?" selects Doug only.
 * 5. If the user message mentions one or more character names
 *    (case-insensitive, word-boundary match), return those participants.
 * 6. If the most recent character turn left a question outstanding for the
 *    user (see findPendingQuestionAsker), return that asker: the user's
 *    message is the answer to their question. This is checked last on
 *    purpose — an explicit group cue or a name always expresses intent more
 *    directly than conversational continuity.
 * 7. Otherwise, return null so the caller can consult the model director.
 *
 * @param {CharacterParticipant[]} participants All participants in the conversation
 * @param {Character[]} characters Character records corresponding to the participants
 * @param {string} userMessage The user's message content
 * @param {Array<{role: string, participant_id?: string, content?: string}>} [recentMessages]
 *   Stored messages (oldest first), used only by the pending-question rule
 * @returns {CharacterParticipant[]|null} The selected participants, or null when no
 *   deterministic rule fires (ambiguous turn). Returns [] when no character
 *   participants exist.
 */
export function selectSpeakerByRules(participants, characters, userMessage, recentMessages = []) {
    const charParticipants = (Array.isArray(participants) ? participants : []).filter(p => p && p.role === 'character');
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
    for (const char of Array.isArray(characters) ? characters : []) {
        nameMap.set(char.id, char.name);
    }

    const directAddress = charParticipants.filter(p => {
        const name = nameMap.get(p.character_id);
        if (!name || typeof name !== 'string' || name === '') {
            return false;
        }
        return isDirectAddress(messageLower, name.toLowerCase());
    });
    if (directAddress.length > 0) {
        return directAddress;
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

    // 6. Pending question: the most recent character turn asked the user
    // something, so this message is that character's answer. Deterministic and
    // correct by construction — no model call, no tie-break guess.
    const asker = findPendingQuestionAsker(participants, recentMessages);
    if (asker) {
        return [asker];
    }

    return null;
}

/**
 * Selects which character participant(s) should respond to a user message.
 * Deterministic: the same inputs always produce the same output.
 *
 * Delegates to selectSpeakerByRules; when no deterministic rule fires,
 * falls back to the first character participant (deterministic by order).
 *
 * @param {CharacterParticipant[]} participants All participants in the conversation
 * @param {Character[]} characters Character records corresponding to the participants
 * @param {string} userMessage The user's message content
 * @returns {CharacterParticipant[]} The selected character participants (non-empty when character participants exist)
 */
export function selectSpeaker(participants, characters, userMessage, recentMessages = []) {
    const byRules = selectSpeakerByRules(participants, characters, userMessage, recentMessages);
    if (byRules !== null) {
        return byRules;
    }
    const charParticipants = (Array.isArray(participants) ? participants : []).filter(p => p && p.role === 'character');
    return charParticipants.length > 0 ? [charParticipants[0]] : [];
}

/**
 * Deterministic anti-starvation fallback: picks the character participant
 * who has spoken least often in the recent history. Ties resolve in
 * participant order, so with no history the first character is picked.
 *
 * @param {CharacterParticipant[]} participants All participants in the conversation
 * @param {Array<{role: string, participant_id?: string}>} [recentMessages] Recent stored messages (only role 'character' messages count)
 * @returns {CharacterParticipant[]} At most one participant; [] when no character participants exist
 */
export function leastRecentlySpoken(participants, recentMessages = []) {
    const charParticipants = (Array.isArray(participants) ? participants : []).filter(p => p && p.role === 'character');
    if (charParticipants.length === 0) return [];
    if (charParticipants.length === 1) return charParticipants;
    const counts = new Map(charParticipants.map(p => [p.id, 0]));
    for (const message of Array.isArray(recentMessages) ? recentMessages : []) {
        if (message && message.role === 'character' && typeof message.participant_id === 'string' && counts.has(message.participant_id)) {
            counts.set(message.participant_id, counts.get(message.participant_id) + 1);
        }
    }
    let best = charParticipants[0];
    let bestCount = counts.get(best.id);
    for (let i = 1; i < charParticipants.length; i++) {
        const participant = charParticipants[i];
        const count = counts.get(participant.id);
        if (count < bestCount) {
            best = participant;
            bestCount = count;
        }
    }
    return [best];
}


/**
 * Strictly parses a model-produced speaker decision.
 *
 * Accepts a raw model output string (optionally wrapped in code fences or
 * surrounding prose — the outermost `{...}` block is parsed) or an already
 * parsed object. The result is an array of character IDs in the model's
 * order with duplicates removed.
 *
 * The decision is rejected (null) unless it is an object with a non-empty
 * `speakers` array in which EVERY entry is a string present in `allowedIds`.
 * Unknown, empty, or malformed entries invalidate the whole decision — the
 * director must never be able to address a character that is not in the
 * current conversation.
 *
 * @param {unknown} raw Model output (string or object)
 * @param {string[]} allowedIds Character IDs currently in the conversation
 * @returns {string[]|null} Validated character IDs, or null when invalid
 */
export function parseDirectorDecision(raw, allowedIds = []) {
    const allowed = new Set((Array.isArray(allowedIds) ? allowedIds : [])
        .filter(id => typeof id === 'string' && id !== ''));
    let data = raw;
    if (typeof data === 'string') {
        const text = data.trim();
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start === -1 || end <= start) return null;
        try {
            data = JSON.parse(text.slice(start, end + 1));
        } catch {
            return null;
        }
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
    const speakers = data.speakers;
    if (!Array.isArray(speakers) || speakers.length === 0) return null;
    const result = [];
    for (const id of speakers) {
        if (typeof id !== 'string' || !allowed.has(id)) return null;
        if (!result.includes(id)) result.push(id);
    }
    return result.length > 0 ? result : null;
}

/**
 * Builds the bounded prompt for a model-backed speaker decision on an
 * ambiguous group turn. Only known character IDs are offered, and the model
 * is instructed to reply with a single strict JSON object.
 *
 * @param {object} params
 * @param {CharacterParticipant[]} [params.participants] Conversation participants
 * @param {Character[]} [params.characters] Character records
 * @param {string} [params.userMessage] The user's newest message
 * @param {Array<{role: string, participant_id?: string, content?: string}>} [params.recentMessages] Recent stored messages for context
 * @returns {Array<{ role: string, content: string }>} Two model messages
 */
export function buildDirectorPrompt({ participants = [], characters = [], userMessage = '', recentMessages = [] } = {}) {
    const system = [
        'You are a speaker director for a multi-character roleplay group chat.',
        'Decide which character(s) should respond to the latest user message.',
        'Rules:',
        '- You may only use the character IDs listed in the Characters section. Never invent or guess other IDs.',
        '- Usually choose exactly one character; choose more than one only when the message clearly invites several.',
        '- The recent conversation is labelled with character NAMES, and the Characters section maps each name to its ID. Read that mapping carefully.',
        '- If a character asked the user a question immediately before the newest message, that character is answering: the user\'s message is their reply. Choose that character, not a bystander.',
        '- Vary turn-taking: when the message does not imply otherwise, prefer a character who has not spoken recently.',
        '- Reply with a single JSON object only, no markdown and no commentary: {"speakers": ["character-id"], "reason": "brief internal reason"}',
    ].join('\n');

    const nameById = new Map();
    for (const character of Array.isArray(characters) ? characters : []) {
        if (character && typeof character.id === 'string' && typeof character.name === 'string' && character.name !== '') {
            nameById.set(character.id, character.name);
        }
    }
    const charParticipants = (Array.isArray(participants) ? participants : []).filter(p => p && p.role === 'character');

    const lines = ['Characters:'];
    for (const participant of charParticipants) {
        const name = nameById.get(participant.character_id);
        lines.push(`- id: ${participant.character_id}${typeof name === 'string' ? ` (name: ${name})` : ''}`);
    }
    const recent = (Array.isArray(recentMessages) ? recentMessages : []).slice(-6);
    if (recent.length > 0) {
        lines.push('Recent conversation:');
        // Names, not participant IDs. This prompt previously labelled the
        // transcript with participant IDs (`pm`/`pd`) while the Characters
        // list above used character IDs (`cm`/`cd`) and no names at all, so
        // the director was asked to answer with one ID namespace while being
        // shown another. It could not tell which character had asked a
        // question, and effectively guessed. Reported case: Doug asked
        // "What's your name?", the user answered, and a different character
        // was selected because Doug was not identifiable in the transcript.
        const nameByParticipantId = new Map(charParticipants.map(p => [p.id, nameById.get(p.character_id)]));
        for (const message of recent) {
            if (message === null || typeof message !== 'object') continue;
            const content = typeof message.content === 'string' ? message.content : '';
            if (content === '') continue;
            if (message.role !== 'character') {
                lines.push(`User: ${content}`);
                continue;
            }
            const name = typeof message.participant_id === 'string'
                ? nameByParticipantId.get(message.participant_id)
                : undefined;
            lines.push(`${typeof name === 'string' && name !== '' ? name : 'Unknown character'}: ${content}`);
        }
    }
    lines.push(`User's newest message: ${typeof userMessage === 'string' ? userMessage : ''}`);
    lines.push('Choose the speaker(s) now.');

    return [
        { role: 'system', content: system },
        { role: 'user', content: lines.join('\n') },
    ];
}

// Bounded generation for the tiny director decision call.
const DIRECTOR_MAX_MODEL_TOKENS = 200;

/**
 * Selects speakers with the hybrid STAB-006 design: deterministic rules
 * first; for an ambiguous multi-character turn, an optional bounded model
 * decision; strict validation of that decision; and a deterministic
 * least-recently-spoken fallback when no model is available or the model
 * output is invalid or fails. Never returns a participant whose character
 * is not in the conversation.
 *
 * @param {object} params
 * @param {CharacterParticipant[]} [params.participants] Conversation participants
 * @param {Character[]} [params.characters] Character records
 * @param {string} [params.userMessage] The user's newest message
 * @param {Array<{role: string, participant_id?: string, content?: string}>} [params.recentMessages] Recent stored messages
 * @param {{ chatCompletion: (messages: Array<{role: string, content: string}>, options?: object) => Promise<unknown> }} [params.provider] Model provider for the director call
 * @returns {Promise<CharacterParticipant[]>} Selected participants in participant order (empty when no character participants exist)
 */
export async function selectSpeakers({ participants = [], characters = [], userMessage = '', recentMessages = [], provider = null } = {}) {
    const byRules = selectSpeakerByRules(participants, characters, userMessage, recentMessages);
    if (byRules !== null) {
        return byRules;
    }
    const charParticipants = (Array.isArray(participants) ? participants : []).filter(p => p && p.role === 'character');
    const fallback = leastRecentlySpoken(participants, recentMessages);
    if (!provider || charParticipants.length < 2) {
        return fallback;
    }
    const byCharacterId = new Map(charParticipants.map(p => [p.character_id, p]));
    try {
        const prompt = buildDirectorPrompt({ participants, characters, userMessage, recentMessages });
        // This is a classification, not an answer: the director must name
        // speakers inside a tiny budget. A reasoning model spends that budget on
        // a `reasoning_content` phase OpenParlor never reads and returns an
        // empty decision, which silently demoted every group turn to the
        // deterministic fallback. The thinking phase is therefore always off
        // here, regardless of the deployment's turn-level policy.
        const completion = await provider.chatCompletion(prompt, {
            max_tokens: DIRECTOR_MAX_MODEL_TOKENS,
            disableThinking: true,
        });
        const raw = typeof completion?.choices?.[0]?.message?.content === 'string'
            ? completion.choices[0].message.content
            : '';
        const ids = parseDirectorDecision(raw, [...byCharacterId.keys()]);
        if (ids) {
            const chosen = new Set(ids);
            const selected = charParticipants.filter(p => chosen.has(p.character_id));
            if (selected.length > 0) {
                return selected;
            }
        }
    } catch (error) {
        console.error('OpenParlor: speaker director decision failed', error);
    }
    return fallback;
}
