import * as persistence from './persistence.js';

const MAX_CONTENT_LENGTH = 500;
const MAX_CANDIDATES = 5;
const VALID_TYPES = new Set(['fact', 'preference', 'event', 'relationship', 'other']);

const TRIVIAL_PATTERNS = [
    /^(hi|hello|hey|ok|okay|thanks|thank you|bye|goodbye|cool|nice|great|sure|yes|no|maybe|lol|haha|wow|oh|um|uh|right|got it|i see|sounds good|no problem|youre welcome|welcome|sure thing|alright|k|kk|ty|thx|np|gm|gn|brb|idk|lmao|rofl|omg|wtf|yep|nah|yeah|yup|nope|uhh|hmm|mm|mmh|mmhm|mmhmm)\.?$/i,
    /^(i (am|is|are|was|were) (fine|good|ok|okay|great|well|doing well|doing good))\.?$/i,
    /^(how are you|what's up|whats up|how's it going|hows it going)\.?$/i,
];

const INSTRUCTION_PATTERNS = [
    /you are (a|an|the)\s/i,
    /you must (always|never|only)\s/i,
    /system prompt/i,
    /ignore (?:all\s+)?(?:previous|prior)?\s*(instructions|prompts)/i,
    /act as (a|an|the)\s/i,
    /your role is to/i,
];

/**
 * Normalizes a string for deduplication comparison.
 * @param {string} s
 * @returns {string}
 */
function normalizeForDedup(s) {
    return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Checks if a candidate fact is trivial dialogue.
 * @param {string} content
 * @returns {boolean}
 */
function isTrivial(content) {
    const trimmed = content.trim().replace(/[.!?]+$/, '');
    if (trimmed.length < 3) return true;
    return TRIVIAL_PATTERNS.some(p => p.test(trimmed));
}

/**
 * Checks if a candidate fact looks like a model instruction.
 * @param {string} content
 * @returns {boolean}
 */
function isInstruction(content) {
    return INSTRUCTION_PATTERNS.some(p => p.test(content));
}

/**
 * Validates a single candidate fact from the model output.
 * @param {unknown} candidate
 * @returns {{content: string, type: string, importance: number, confidence: number} | null}
 */
function validateCandidate(candidate) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const c = /** @type {Record<string, unknown>} */ (candidate);
    if (typeof c.content !== 'string' || c.content.trim() === '') return null;
    const content = c.content.trim();
    if (content.length > MAX_CONTENT_LENGTH) return null;
    if (isTrivial(content)) return null;
    if (isInstruction(content)) return null;
    const type = typeof c.type === 'string' && VALID_TYPES.has(c.type) ? c.type : 'other';
    const importance = typeof c.importance === 'number' && Number.isFinite(c.importance)
        ? Math.max(0, Math.min(1, c.importance)) : 0.5;
    const confidence = typeof c.confidence === 'number' && Number.isFinite(c.confidence)
        ? Math.max(0, Math.min(1, c.confidence)) : 0.5;
    return { content, type, importance, confidence };
}

/**
 * Parses the model's JSON response into validated candidates.
 * @param {string} raw
 * @returns {Array<{content: string, type: string, importance: number, confidence: number}>}
 */
export function parseCandidates(raw) {
    if (typeof raw !== 'string' || raw.trim() === '') return [];
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        const match = raw.match(/\[[\s\S]*\]/);
        if (!match) return [];
        try {
            parsed = JSON.parse(match[0]);
        } catch {
            return [];
        }
    }
    if (!Array.isArray(parsed)) return [];
    const candidates = [];
    for (const item of parsed.slice(0, MAX_CANDIDATES)) {
        const validated = validateCandidate(item);
        if (validated) candidates.push(validated);
    }
    return candidates;
}

/**
 * Deduplicates candidates against existing active memories.
 * @param {Array<{content: string, type: string, importance: number, confidence: number}>} candidates
 * @param {Array<{content: string, active: boolean}>} existingMemories
 * @returns {Array<{content: string, type: string, importance: number, confidence: number}>}
 */
export function deduplicate(candidates, existingMemories) {
    const existingSet = new Set(
        existingMemories.filter(m => m.active).map(m => normalizeForDedup(m.content)),
    );
    const seen = new Set();
    return candidates.filter(c => {
        const key = normalizeForDedup(c.content);
        if (existingSet.has(key) || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/**
 * Builds the extraction prompt for the model.
 * @param {{character: object, conversation: object, messages: Array<{role: string, content: string}>}} context
 * @returns {Array<{role: string, content: string}>}
 */
export function buildExtractionPrompt(context) {
    const { character, messages } = context;
    const dialogue = messages
        .map(m => `${m.role === 'user' ? 'User' : character.name}: ${m.content}`)
        .join('\n');
    const systemPrompt = [
        'You are a memory extraction assistant. Analyze the dialogue below and extract durable facts,',
        'preferences, events, or relationship details that would be useful to remember in future conversations.',
        '',
        'Rules:',
        '- Only extract information that is explicitly stated or strongly implied by the user.',
        '- Do NOT extract trivial greetings, farewells, or small talk.',
        '- Do NOT extract instructions or meta-commentary about the AI.',
        '- Each fact should be a single, self-contained sentence.',
        '- Assign a type: "fact", "preference", "event", "relationship", or "other".',
        '- Assign importance (0-1) and confidence (0-1) for each.',
        '- Return at most 5 candidates.',
        '- If there is nothing worth remembering, return an empty array.',
        '',
        'Respond with a JSON array of objects: [{"content": "...", "type": "...", "importance": 0.0, "confidence": 0.0}]',
    ].join('\n');

    return [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Character: ${character.name}\nScenario: ${character.scenario || 'None'}\n\nDialogue:\n${dialogue}` },
    ];
}

/**
 * Extracts and persists memory candidates from a completed conversation turn.
 * Designed to be called asynchronously (fire-and-forget) after a successful
 * chat response. All failures are contained internally.
 *
 * @param {object} params
 * @param {import('../users.js').UserDirectoryList} params.directories
 * @param {string} params.owner_id
 * @param {object} params.character
 * @param {object} params.conversation
 * @param {Array<{role: string, content: string}>} params.messages
 * @param {string} params.source_message_id
 * @param {string[]} params.known_by_character_ids
 * @param {{ chatCompletion: (messages: Array<{role: string, content: string}>) => Promise<{choices: Array<{message: {content: string}}>} } }} params.provider
 * @returns {Promise<Array<object>>} Persisted memories
 */
export async function extractAndPersistMemories({
    directories,
    owner_id,
    character,
    conversation,
    messages,
    source_message_id,
    known_by_character_ids,
    provider,
}) {
    const prompt = buildExtractionPrompt({ character, conversation, messages });
    const completion = await provider.chatCompletion(prompt);
    const raw = typeof completion?.choices?.[0]?.message?.content === 'string'
        ? completion.choices[0].message.content
        : '';

    let candidates = parseCandidates(raw);
    if (candidates.length === 0) return [];

    const existing = persistence.listMemories(directories, owner_id, character.id);
    candidates = deduplicate(candidates, existing);
    if (candidates.length === 0) return [];

    const persisted = [];
    for (const candidate of candidates) {
        const memory = persistence.createMemory(directories, owner_id, {
            character_id: character.id,
            conversation_id: conversation.id,
            content: candidate.content,
            type: candidate.type,
            importance: candidate.importance,
            confidence: candidate.confidence,
            active: true,
            source_conversation_id: conversation.id,
            source_message_id,
            known_by_character_ids,
        });
        persisted.push(memory);
    }
    return persisted;
}
