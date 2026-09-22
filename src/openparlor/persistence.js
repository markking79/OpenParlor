import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

/**
 * @typedef {object} Character
 * @property {string} id UUID v4
 * @property {string} name
 * @property {string} description
 * @property {string} personality
 * @property {string} scenario
 * @property {string} first_message
 * @property {string} system_prompt
 * @property {string} example_dialogue
 * @property {string[]} tags
 * @property {string} [avatar_url] Relative URL (no filesystem paths)
 * @property {string} tts_provider
 * @property {string} tts_voice
 * @property {number} [temperature] Generation temperature 0–2
 * @property {number} [max_tokens] Maximum response tokens 1–8192
 * @property {boolean} [time_aware] Whether to include server-derived time context in prompts
 * @property {string} owner_id User handle
 * @property {string} created_at ISO 8601
 * @property {string} updated_at ISO 8601
 */

/**
 * @typedef {object} ConversationParticipant
 * @property {string} id UUID v4
 * @property {string} conversation_id FK → Conversation
 * @property {string} character_id FK → Character
 * @property {'user'|'character'|'system'} role
 * @property {string} joined_at ISO 8601
 */

/**
 * @typedef {object} Conversation
 * @property {string} id UUID v4
 * @property {string} title
 * @property {string} character_id FK → Character (primary character)
 * @property {string} owner_id User handle
 * @property {string} created_at ISO 8601
 * @property {string} updated_at ISO 8601
 * @property {ConversationParticipant[]} participants
 * @property {boolean} [archived] Whether the conversation is archived
 */

/**
 * @typedef {object} Message
 * @property {string} id UUID v4
 * @property {string} conversation_id FK → Conversation
 * @property {string} participant_id FK → ConversationParticipant
 * @property {string} content
 * @property {'user'|'character'|'system'} role
 * @property {string} created_at ISO 8601
 */

/**
 * @typedef {object} Memory
 * @property {string} id UUID v4
 * @property {string} character_id FK → Character (primary character)
 * @property {string|null} conversation_id FK → Conversation (nullable)
 * @property {string} content
 * @property {'fact'|'preference'|'event'|'relationship'|'other'} type
 * @property {number} importance 0–1
 * @property {number} confidence 0–1
 * @property {boolean} active
 * @property {string|null} superseded_by FK → Memory (nullable)
 * @property {string|null} source_conversation_id FK → Conversation (nullable)
 * @property {string|null} source_message_id FK → Message (nullable)
 * @property {string[]} known_by_character_ids
 * @property {string} owner_id User handle
 * @property {string} created_at ISO 8601
 * @property {string} updated_at ISO 8601
 */

/**
 * @typedef {object} UserOpenParlorSettings
 * @property {string} owner_id User handle
 * @property {string} [default_model]
 * @property {number} [temperature]
 * @property {number} [max_tokens]
 * @property {boolean} [memory_enabled]
 * @property {number} [memory_limit]
 * @property {string} updated_at ISO 8601
 */

/**
 * @typedef {object} Meta
 * @property {number} version Schema version
 * @property {string} created_at ISO 8601
 */

const CURRENT_SCHEMA_VERSION = 1;
const MEMORY_TYPES = new Set(['fact', 'preference', 'event', 'relationship', 'other']);

/**
 * Returns the OpenParlor data root for a given user.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {string} Absolute path to the user's openparlor directory
 */
export function getOpenParlorRoot(directories) {
    return path.resolve(directories.root, 'openparlor');
}

/**
 * Resolves a sub-path within the OpenParlor root, ensuring it does not escape.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {...string} segments
 * @returns {string}
 */
function resolveWithinRoot(directories, ...segments) {
    const root = getOpenParlorRoot(directories);
    const resolved = path.resolve(root, ...segments);
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
        throw new Error(`Path escapes OpenParlor root: ${resolved}`);
    }
    return resolved;
}

/**
 * Safely parses a JSON file, returning null on missing file or parse error.
 * @param {string} filePath
 * @returns {any|null}
 */
function safeReadJSON(filePath) {
    if (!fs.existsSync(filePath)) return null;
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return null;
    }
}

/**
 * Produces an update timestamp that is strictly newer than the stored value,
 * even when two writes happen in the same millisecond.
 * @param {string} previousTimestamp
 * @returns {string}
 */
function nextUpdatedAt(previousTimestamp) {
    const previous = Date.parse(previousTimestamp);
    return new Date(Math.max(Date.now(), Number.isNaN(previous) ? 0 : previous + 1)).toISOString();
}

/**
 * Ensures the OpenParlor directory structure exists for a user.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {string} The openparlor root path
 */
export function ensureOpenParlorDirs(directories) {
    const root = getOpenParlorRoot(directories);
    const subdirs = ['characters', 'conversations', 'memories'];
    for (const sub of subdirs) {
        const dir = path.join(root, sub);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }
    // Create meta.json if it doesn't exist (migration anchor)
    const metaPath = path.join(root, 'meta.json');
    if (!fs.existsSync(metaPath)) {
        /** @type {Meta} */
        const meta = { version: CURRENT_SCHEMA_VERSION, created_at: new Date().toISOString() };
        writeFileAtomicSync(metaPath, JSON.stringify(meta, null, 2));
    }
    return root;
}

/**
 * Reads and returns the schema version from meta.json.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {number}
 */
export function getSchemaVersion(directories) {
    const metaPath = path.join(getOpenParlorRoot(directories), 'meta.json');
    if (!fs.existsSync(metaPath)) return CURRENT_SCHEMA_VERSION;
    try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        return meta.version ?? CURRENT_SCHEMA_VERSION;
    } catch {
        return CURRENT_SCHEMA_VERSION;
    }
}

// ─── Character ───────────────────────────────────────────────────────────────

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} id
 * @returns {string}
 */
function characterPath(directories, id) {
    return resolveWithinRoot(directories, 'characters', `${id}.json`);
}

/**
 * Returns a persisted character in the current schema without forcing a
 * migration write for records created before optional fields were introduced.
 * @param {unknown} value
 * @returns {Character|null}
 */
function normalizeCharacter(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const character = /** @type {Record<string, unknown>} */ (value);
    if (typeof character.id !== 'string' || typeof character.owner_id !== 'string'
        || typeof character.created_at !== 'string' || typeof character.updated_at !== 'string') {
        return null;
    }
    const stringField = (name) => typeof character[name] === 'string' ? character[name] : '';
    return {
        ...character,
        id: character.id,
        name: stringField('name'),
        description: stringField('description'),
        personality: stringField('personality'),
        scenario: stringField('scenario'),
        first_message: stringField('first_message'),
        system_prompt: stringField('system_prompt'),
        example_dialogue: stringField('example_dialogue'),
        tags: Array.isArray(character.tags) ? character.tags.filter(tag => typeof tag === 'string') : [],
        ...(typeof character.avatar_url === 'string' ? { avatar_url: character.avatar_url } : {}),
        tts_provider: stringField('tts_provider'),
        tts_voice: stringField('tts_voice'),
        ...(typeof character.temperature === 'number' && Number.isFinite(character.temperature) ? { temperature: character.temperature } : {}),
        ...(typeof character.max_tokens === 'number' && Number.isFinite(character.max_tokens) ? { max_tokens: character.max_tokens } : {}),
        ...(typeof character.time_aware === 'boolean' ? { time_aware: character.time_aware } : {}),
        owner_id: character.owner_id,
        created_at: character.created_at,
        updated_at: character.updated_at,
    };
}

/**
 * Creates a new Character entity and persists it.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} owner_id
 * @param {Partial<Character>} data
 * @returns {Character}
 */
export function createCharacter(directories, owner_id, data) {
    ensureOpenParlorDirs(directories);
    const now = new Date().toISOString();
    /** @type {Character} */
    const character = {
        id: crypto.randomUUID(),
        name: data.name ?? '',
        description: data.description ?? '',
        personality: data.personality ?? '',
        scenario: data.scenario ?? '',
        first_message: data.first_message ?? '',
        system_prompt: data.system_prompt ?? '',
        example_dialogue: data.example_dialogue ?? '',
        tags: Array.isArray(data.tags) ? data.tags.filter(tag => typeof tag === 'string') : [],
        ...(typeof data.avatar_url === 'string' ? { avatar_url: data.avatar_url } : {}),
        tts_provider: data.tts_provider ?? '',
        tts_voice: data.tts_voice ?? '',
        ...(typeof data.temperature === 'number' && Number.isFinite(data.temperature) ? { temperature: data.temperature } : {}),
        ...(typeof data.max_tokens === 'number' && Number.isFinite(data.max_tokens) ? { max_tokens: data.max_tokens } : {}),
        ...(typeof data.time_aware === 'boolean' ? { time_aware: data.time_aware } : {}),
        owner_id,
        created_at: now,
        updated_at: now,
    };
    writeFileAtomicSync(characterPath(directories, character.id), JSON.stringify(character, null, 2));
    return character;
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} id
 * @returns {Character|null}
 */
export function getCharacter(directories, id) {
    return normalizeCharacter(safeReadJSON(characterPath(directories, id)));
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} owner_id
 * @returns {Character[]}
 */
export function listCharacters(directories, owner_id) {
    const dir = resolveWithinRoot(directories, 'characters');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .map(f => normalizeCharacter(safeReadJSON(path.join(dir, f))))
        .filter(c => c !== null && c.owner_id === owner_id);
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} id
 * @param {Partial<Character>} updates
 * @returns {Character|null}
 */
export function updateCharacter(directories, id, updates) {
    const existing = getCharacter(directories, id);
    if (!existing) return null;
    const updated = normalizeCharacter({
        ...existing,
        ...updates,
        tags: Array.isArray(updates.tags) ? updates.tags.filter(tag => typeof tag === 'string') : existing.tags,
        id: existing.id,
        owner_id: existing.owner_id,
        created_at: existing.created_at,
        updated_at: nextUpdatedAt(existing.updated_at),
    });
    if (!updated) return null;
    writeFileAtomicSync(characterPath(directories, id), JSON.stringify(updated, null, 2));
    return updated;
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} id
 * @returns {boolean}
 */
export function deleteCharacter(directories, id) {
    const p = characterPath(directories, id);
    if (!fs.existsSync(p)) return false;
    fs.unlinkSync(p);
    return true;
}

// ─── Conversation ────────────────────────────────────────────────────────────

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} id
 * @returns {string}
 */
function conversationPath(directories, id) {
    return resolveWithinRoot(directories, 'conversations', `${id}.json`);
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} id
 * @returns {string}
 */
function conversationMessagesPath(directories, id) {
    return resolveWithinRoot(directories, 'conversations', id, 'messages.jsonl');
}

/**
 * Creates a new Conversation with participants.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} owner_id
 * @param {string} character_id
 * @param {string} title
 * @param {Array<{character_id: string, role: string}>} [participants]
 * @returns {Conversation}
 */
export function createConversation(directories, owner_id, character_id, title, participants = []) {
    ensureOpenParlorDirs(directories);
    const now = new Date().toISOString();
    const convId = crypto.randomUUID();

    /** @type {ConversationParticipant[]} */
    const parts = participants.map(p => ({
        id: crypto.randomUUID(),
        conversation_id: convId,
        character_id: p.character_id,
        role: p.role ?? 'character',
        joined_at: now,
    }));

    // Always include the primary character as a participant if not already listed
    if (!parts.some(p => p.character_id === character_id)) {
        parts.push({
            id: crypto.randomUUID(),
            conversation_id: convId,
            character_id,
            role: 'character',
            joined_at: now,
        });
    }

    /** @type {Conversation} */
    const conversation = {
        id: convId,
        title,
        character_id,
        owner_id,
        created_at: now,
        updated_at: now,
        participants: parts,
        archived: false,
    };

    writeFileAtomicSync(conversationPath(directories, convId), JSON.stringify(conversation, null, 2));

    // Create the messages directory and empty file
    const msgDir = path.join(getOpenParlorRoot(directories), 'conversations', convId);
    if (!fs.existsSync(msgDir)) fs.mkdirSync(msgDir, { recursive: true });
    const msgPath = conversationMessagesPath(directories, convId);
    if (!fs.existsSync(msgPath)) writeFileAtomicSync(msgPath, '');

    return conversation;
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} id
 * @returns {Conversation|null}
 */
export function getConversation(directories, id) {
    return safeReadJSON(conversationPath(directories, id));
}

/**
 * Lists non-archived conversations for a user, sorted by most recently updated first.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} owner_id
 * @returns {Conversation[]}
 */
export function listConversations(directories, owner_id) {
    const dir = resolveWithinRoot(directories, 'conversations');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .map(f => safeReadJSON(path.join(dir, f)))
        .filter(c => c !== null && c.owner_id === owner_id && !c.archived)
        .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} id
 * @param {Partial<Conversation>} updates
 * @returns {Conversation|null}
 */
export function updateConversation(directories, id, updates) {
    const existing = getConversation(directories, id);
    if (!existing) return null;
    const updated = { ...existing, ...updates, id: existing.id, owner_id: existing.owner_id, created_at: existing.created_at, updated_at: nextUpdatedAt(existing.updated_at) };
    writeFileAtomicSync(conversationPath(directories, id), JSON.stringify(updated, null, 2));
    return updated;
}

/**
 * Deletes a conversation and all its messages.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} id
 * @returns {boolean}
 */
export function deleteConversation(directories, id) {
    const p = conversationPath(directories, id);
    if (!fs.existsSync(p)) return false;
    fs.unlinkSync(p);
    const msgDir = path.join(getOpenParlorRoot(directories), 'conversations', id);
    if (fs.existsSync(msgDir)) {
        fs.rmSync(msgDir, { recursive: true, force: true });
    }
    return true;
}

// ─── Message ─────────────────────────────────────────────────────────────────

/**
 * Appends a message to the conversation's JSONL file.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} conversation_id
 * @param {string} participant_id
 * @param {string} content
 * @param {'user'|'character'|'system'} role
 * @returns {Message}
 */
export function appendMessage(directories, conversation_id, participant_id, content, role) {
    ensureOpenParlorDirs(directories);
    /** @type {Message} */
    const message = {
        id: crypto.randomUUID(),
        conversation_id,
        participant_id,
        content,
        role,
        created_at: new Date().toISOString(),
    };
    const msgPath = conversationMessagesPath(directories, conversation_id);
    const dir = path.dirname(msgPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(msgPath, JSON.stringify(message) + '\n');
    // Update conversation timestamp
    const conv = getConversation(directories, conversation_id);
    if (conv) {
        conv.updated_at = message.created_at;
        writeFileAtomicSync(conversationPath(directories, conversation_id), JSON.stringify(conv, null, 2));
    }
    return message;
}

/**
 * Reads all messages for a conversation. Tolerates a trailing corrupt or
 * incomplete JSONL record (e.g. after a crash mid-write).
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} conversation_id
 * @returns {Message[]}
 */
export function getMessages(directories, conversation_id) {
    const msgPath = conversationMessagesPath(directories, conversation_id);
    if (!fs.existsSync(msgPath)) return [];
    const lines = fs.readFileSync(msgPath, 'utf8').split('\n').filter(Boolean);
    /** @type {Message[]} */
    const messages = [];
    for (const line of lines) {
        try {
            messages.push(JSON.parse(line));
        } catch {
            // Skip malformed lines (e.g. trailing incomplete record after crash)
        }
    }
    return messages;
}

// ─── Memory ──────────────────────────────────────────────────────────────────

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} id
 * @returns {string}
 */
function memoryPath(directories, id) {
    return resolveWithinRoot(directories, 'memories', `${id}.json`);
}

/**
 * Normalizes a raw memory record, providing safe defaults for fields that may
 * be missing in legacy records. Returns null if the record is structurally invalid.
 * @param {unknown} value
 * @returns {Memory|null}
 */
function normalizeMemory(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const mem = /** @type {Record<string, unknown>} */ (value);
    if (typeof mem.id !== 'string' || typeof mem.owner_id !== 'string'
        || typeof mem.created_at !== 'string' || typeof mem.updated_at !== 'string') {
        return null;
    }
    const clamp01 = (v) => {
        const n = typeof v === 'number' && Number.isFinite(v) ? v : 0.5;
        return Math.max(0, Math.min(1, n));
    };
    return {
        ...mem,
        id: mem.id,
        character_id: typeof mem.character_id === 'string' ? mem.character_id : '',
        conversation_id: typeof mem.conversation_id === 'string' ? mem.conversation_id : null,
        content: typeof mem.content === 'string' ? mem.content : '',
        type: typeof mem.type === 'string' && MEMORY_TYPES.has(mem.type) ? mem.type : 'other',
        importance: clamp01(mem.importance),
        confidence: clamp01(mem.confidence),
        active: typeof mem.active === 'boolean' ? mem.active : true,
        superseded_by: typeof mem.superseded_by === 'string' ? mem.superseded_by : null,
        source_conversation_id: typeof mem.source_conversation_id === 'string' ? mem.source_conversation_id : null,
        source_message_id: typeof mem.source_message_id === 'string' ? mem.source_message_id : null,
        known_by_character_ids: Array.isArray(mem.known_by_character_ids)
            ? mem.known_by_character_ids.filter(id => typeof id === 'string')
            : (typeof mem.character_id === 'string' && mem.character_id ? [mem.character_id] : []),
        owner_id: mem.owner_id,
        created_at: mem.created_at,
        updated_at: mem.updated_at,
    };
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} owner_id
 * @param {Partial<Memory>} data
 * @returns {Memory}
 */
export function createMemory(directories, owner_id, data) {
    ensureOpenParlorDirs(directories);
    const now = new Date().toISOString();
    const memory = normalizeMemory({
        id: crypto.randomUUID(),
        character_id: data.character_id ?? '',
        conversation_id: data.conversation_id ?? null,
        content: data.content ?? '',
        type: data.type ?? 'other',
        importance: data.importance ?? 0.5,
        confidence: data.confidence ?? 0.5,
        active: data.active ?? true,
        superseded_by: data.superseded_by ?? null,
        source_conversation_id: data.source_conversation_id ?? null,
        source_message_id: data.source_message_id ?? null,
        known_by_character_ids: data.known_by_character_ids ?? [],
        owner_id,
        created_at: now,
        updated_at: now,
    });
    if (!memory) throw new Error('Failed to normalize memory');
    writeFileAtomicSync(memoryPath(directories, memory.id), JSON.stringify(memory, null, 2));
    return memory;
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} id
 * @returns {Memory|null}
 */
export function getMemory(directories, id) {
    return normalizeMemory(safeReadJSON(memoryPath(directories, id)));
}

/**
 * Lists memories visible to a given character, preserving ownership isolation.
 * Uses knowledge visibility (known_by_character_ids) rather than a global
 * shared memory. Returns results in deterministic order (created_at desc, id asc).
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} owner_id
 * @param {string} [character_id]
 * @returns {Memory[]}
 */
export function listMemories(directories, owner_id, character_id) {
    const dir = resolveWithinRoot(directories, 'memories');
    if (!fs.existsSync(dir)) return [];
    let memories = fs.readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .map(f => normalizeMemory(safeReadJSON(path.join(dir, f))))
        .filter(m => m !== null && m.owner_id === owner_id);
    if (character_id) {
        memories = memories.filter(m => m.known_by_character_ids.includes(character_id));
    }
    memories.sort((a, b) => {
        const ta = new Date(a.created_at).getTime();
        const tb = new Date(b.created_at).getTime();
        if (tb !== ta) return tb - ta;
        return a.id.localeCompare(b.id);
    });
    return memories;
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} id
 * @param {Partial<Memory>} updates
 * @returns {Memory|null}
 */
export function updateMemory(directories, id, updates) {
    const existing = getMemory(directories, id);
    if (!existing) return null;
    const updated = normalizeMemory({
        ...existing,
        ...updates,
        id: existing.id,
        owner_id: existing.owner_id,
        created_at: existing.created_at,
        updated_at: nextUpdatedAt(existing.updated_at),
    });
    if (!updated) return null;
    writeFileAtomicSync(memoryPath(directories, id), JSON.stringify(updated, null, 2));
    return updated;
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} id
 * @returns {boolean}
 */
export function deleteMemory(directories, id) {
    const p = memoryPath(directories, id);
    if (!fs.existsSync(p)) return false;
    fs.unlinkSync(p);
    return true;
}

// ─── UserOpenParlorSettings ──────────────────────────────────────────────────

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @returns {string}
 */
function settingsPath(directories) {
    return resolveWithinRoot(directories, 'settings.json');
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} owner_id
 * @returns {UserOpenParlorSettings}
 */
export function getSettings(directories, owner_id) {
    const p = settingsPath(directories);
    const existing = safeReadJSON(p);
    if (!existing) {
        return { owner_id, updated_at: new Date().toISOString() };
    }
    return existing;
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} owner_id
 * @param {Partial<UserOpenParlorSettings>} updates
 * @returns {UserOpenParlorSettings}
 */
export function saveSettings(directories, owner_id, updates) {
    ensureOpenParlorDirs(directories);
    const existing = getSettings(directories, owner_id);
    /** @type {UserOpenParlorSettings} */
    const settings = { ...existing, ...updates, owner_id, updated_at: new Date().toISOString() };
    writeFileAtomicSync(settingsPath(directories), JSON.stringify(settings, null, 2));
    return settings;
}
