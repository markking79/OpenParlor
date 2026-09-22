import * as persistence from './persistence.js';
import { uniqueSignificantSequence } from './memory-text.js';

const MAX_CONTENT_LENGTH = 500;
const MAX_CANDIDATES = 5;
const VALID_TYPES = new Set(['fact', 'preference', 'event', 'relationship', 'other']);
// Near-duplicate threshold on Jaccard similarity of significant token sets.
const DEDUP_SIMILARITY_THRESHOLD = 0.85;

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

// Patterns for memories that describe the conversation itself (meta-memories)
// instead of durable facts about people or the world.
const META_MEMORY_PATTERNS = [
    /group (chat|conversation|thread)/i,
    /is chatting/i,
    /the (conversation|chat|dialogue) (is|was)/i,
    /this (conversation|chat)/i,
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
 * Checks if a candidate fact describes the conversation itself (a meta-memory)
 * rather than a durable fact. These are rejected at extraction time.
 * @param {string} content
 * @returns {boolean}
 */
function isMetaMemory(content) {
    return META_MEMORY_PATTERNS.some(p => p.test(content));
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
    if (isMetaMemory(content)) return null;
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
 * Deduplicates candidates against existing active memories and against each
 * other. Exact (normalized) matches are dropped, as are near-duplicates whose
 * significant token sets are at least DEDUP_SIMILARITY_THRESHOLD similar
 * (stemming- and filler-word-insensitive comparison).
 * @param {Array<{content: string, type: string, importance: number, confidence: number}>} candidates
 * @param {Array<{content: string, active: boolean}>} existingMemories
 * @returns {Array<{content: string, type: string, importance: number, confidence: number}>}
 */
export function deduplicate(candidates, existingMemories) {
    const existing = existingMemories
        .filter(m => m.active)
        .map(m => ({ key: normalizeForDedup(m.content), tokens: uniqueSignificantSequence(m.content) }));
    const kept = [];
    return candidates.filter(candidate => {
        const key = normalizeForDedup(candidate.content);
        const tokens = uniqueSignificantSequence(candidate.content);
        for (const item of [...existing, ...kept]) {
            if (item.key === key || sequenceSimilarity(tokens, item.tokens) >= DEDUP_SIMILARITY_THRESHOLD) {
                return false;
            }
        }
        kept.push({ key, tokens });
        return true;
    });
}

/**
 * Computes the Jaccard similarity between two significant-token sequences.
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number}
 */
function sequenceSimilarity(a, b) {
    if (a.length === 0 || b.length === 0) return 0;
    const setA = new Set(a);
    const setB = new Set(b);
    let intersection = 0;
    for (const token of setA) {
        if (setB.has(token)) intersection++;
    }
    const union = setA.size + setB.size - intersection;
    return union === 0 ? 0 : intersection / union;
}

/**
 * Builds the extraction prompt for the model.
 * @param {{character: object, conversation: object, messages: Array<{role: string, content: string}>, participants?: Array<{name: string}>}} context
 * @returns {Array<{role: string, content: string}>}
 */
export function buildExtractionPrompt(context) {
    const { character, messages, participants } = context;
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
        '- Do not extract meta-facts about this conversation itself (e.g. who is in the group chat, that a chat is happening). Only extract durable facts about people, relationships, or the world.',
        '- If the same person is mentioned alongside other characters, attribute the fact to the correct person.',
        '- Each fact should be a single, self-contained sentence.',
        '- Assign a type: "fact", "preference", "event", "relationship", or "other".',
        '- Assign importance (0-1) and confidence (0-1) for each.',
        '- Return at most 5 candidates.',
        '- If there is nothing worth remembering, return an empty array.',
        '',
        'Respond with a JSON array of objects: [{"content": "...", "type": "...", "importance": 0.0, "confidence": 0.0}]',
    ].join('\n');

    const participantLine = Array.isArray(participants) && participants.length > 1
        ? `\nCharacters present: ${participants.map(p => p.name).join(', ')}`
        : '';
    const userPrompt = `Character: ${character.name}\nScenario: ${character.scenario || 'None'}${participantLine}\n\nDialogue:\n${dialogue}`;

    return [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
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
 * @param {Array<{name: string}>} [params.participants] Character names present in group context
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
    participants,
    provider,
}) {
    const prompt = buildExtractionPrompt({ character, conversation, messages, participants });
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
