import * as persistence from './persistence.js';
import { uniqueSignificantSequence, normalizeSubject } from './memory-text.js';

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
 * @returns {{content: string, type: string, importance: number, confidence: number, subject: string|null} | null}
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
    // The subject is optional. A memory without one simply never supersedes
    // anything, which is the safe default: an invented subject must not be
    // able to retire a fact the user never corrected.
    const subject = typeof c.subject === 'string' && normalizeSubject(c.subject) !== ''
        ? c.subject.trim() : null;
    return { content, type, importance, confidence, subject };
}

/**
 * Parses the model's JSON response into validated candidates.
 * @param {string} raw
 * @returns {Array<{content: string, type: string, importance: number, confidence: number, subject: string|null}>}
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
        '- For each fact, also give a short "subject" naming what the fact is about (e.g. "user employer", "user sister").',
        '- Use the SAME subject for a fact and any later correction of it, so the old one can be retired. Omit "subject" for one-off events that will never be corrected.',
        '',
        'Respond with a JSON array of objects: [{"content": "...", "type": "...", "importance": 0.0, "confidence": 0.0, "subject": "..."}]',
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
 * Finds the active memories that conflict with a newly extracted candidate.
 *
 * Returns them split by which side is newer, because the two cases are
 * opposites and the caller must not conflate them:
 *
 *   stale   -- existing memories that are NEWER than this candidate. The
 *              candidate is a late extraction of an older statement, so it
 *              must not retire them; it is itself the outdated one.
 *   older   -- existing memories that this candidate corrects. It retires
 *              these.
 *
 * A candidate supersedes an existing memory when:
 *   - it declares a subject, and the existing memory has the SAME subject;
 *   - the contents are genuinely different (an exact/near duplicate is a
 *     duplicate, not a correction -- that case is already handled by
 *     deduplicate());
 *   - the existing memory is still active (we never re-supersede something
 *     already retired, so chains stay flat and cannot loop).
 *
 * Without a subject we cannot tell a correction from a new fact, so nothing
 * is superseded. Guessing here would silently delete the user's history.
 *
 * @param {{content: string, subject: string|null}} candidate
 * @param {Array<object>} existing Active memories visible to the character
 * @param {string} candidateSourceTime ISO timestamp of the turn this came from
 * @returns {{stale: string[], older: string[]}} memory IDs, split by recency
 */
function findConflicts(candidate, existing, candidateSourceTime) {
    const key = normalizeSubject(candidate.subject);
    if (key === '') return { stale: [], older: [] };
    const normalizedContent = normalizeForDedup(candidate.content);
    const candidateTime = Date.parse(candidateSourceTime);
    const stale = [];
    const older = [];
    for (const mem of existing) {
        if (!mem || mem.active !== true) continue;
        if (normalizeSubject(mem.subject) !== key) continue;
        if (normalizeForDedup(mem.content) === normalizedContent) continue;
        // Compare the SOURCE turn, never the arrival time. Extraction is
        // fire-and-forget, so a slow call can deliver an old statement long
        // after a newer one was already stored; ordering by arrival would let
        // that stale fact retire the correction and resurrect the old answer.
        const memTime = Date.parse(mem.source_created_at);
        if (Number.isFinite(candidateTime) && Number.isFinite(memTime) && memTime > candidateTime) {
            stale.push(mem.id);
        } else {
            older.push(mem.id);
        }
    }
    return { stale, older };
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
 * @param {string|null} [params.source_timestamp] ISO time of the turn being
 *   summarized. Supersession compares this, not arrival order, so a late
 *   extraction cannot overwrite newer state.
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
    source_timestamp = null,
    participants,
    provider,
}) {
    // The turn this extraction describes, used to decide whether a candidate
    // is newer or older than what is already stored. Extraction is
    // fire-and-forget, so a slow call can deliver an old statement long after
    // a newer one landed; ordering by arrival time would let the stale fact
    // win. Defaults to now, which preserves the ordinary "latest wins" order.
    const sourceTimestamp = Number.isFinite(Date.parse(source_timestamp))
        ? new Date(Date.parse(source_timestamp)).toISOString()
        : new Date().toISOString();

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
        const { stale, older } = findConflicts(candidate, existing, sourceTimestamp);
        // A candidate that lost to a newer statement is itself recorded as
        // outdated, rather than dropped: provenance is the point of keeping
        // retired memories, and silently discarding it would make the store
        // disagree with what the user actually said.
        const isStale = stale.length > 0;
        const memory = persistence.createMemory(directories, owner_id, {
            character_id: character.id,
            conversation_id: conversation.id,
            content: candidate.content,
            type: candidate.type,
            importance: candidate.importance,
            confidence: candidate.confidence,
            active: !isStale,
            subject: candidate.subject,
            source_created_at: sourceTimestamp,
            source_conversation_id: conversation.id,
            source_message_id,
            known_by_character_ids,
        });
        // Retiring happens only AFTER the replacement is on disk; the other
        // order leaves a window where the fact is neither current nor
        // recorded if the write failed.
        // A stale candidate retires NOTHING: the newer statement it lost to
        // stays active, and the candidate itself is the outdated record.
        // Retiring by ARRIVAL order instead would let a slow extraction
        // resurrect a fact the user already corrected.
        const toRetire = isStale ? [] : older;
        for (const oldId of toRetire) {
            persistence.updateMemory(directories, oldId, {
                active: false,
                superseded_by: memory.id,
            });
        }
        // A stale candidate points at the newer statement that beat it.
        if (isStale) {
            persistence.updateMemory(directories, memory.id, {
                superseded_by: stale[0],
            });
        }
        persisted.push(memory);
    }
    return persisted;
}
