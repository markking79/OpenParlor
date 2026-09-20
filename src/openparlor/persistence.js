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
 * @property {string} [avatar_url] Relative URL (no filesystem paths)
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
 * @property {string} character_id FK → Character
 * @property {string|null} conversation_id FK → Conversation (nullable)
 * @property {string} content
 * @property {number} importance 0–1
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

/**
 * Returns the OpenParlor data root for a given user.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {string} Absolute path to the user's openparlor directory
 */
export function getOpenParlorRoot(directories) {
    return path.join(directories.root, 'openparlor');
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
    return path.join(getOpenParlorRoot(directories), 'characters', `${id}.json`);
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
        avatar_url: data.avatar_url,
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
    const p = characterPath(directories, id);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} owner_id
 * @returns {Character[]}
 */
export function listCharacters(directories, owner_id) {
    const dir = path.join(getOpenParlorRoot(directories), 'characters');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
        .filter(c => c.owner_id === owner_id);
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
    const updated = { ...existing, ...updates, id: existing.id, created_at: existing.created_at, updated_at: new Date().toISOString() };
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
    return path.join(getOpenParlorRoot(directories), 'conversations', `${id}.json`);
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} id
 * @returns {string}
 */
function conversationMessagesPath(directories, id) {
    return path.join(getOpenParlorRoot(directories), 'conversations', id, 'messages.jsonl');
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
    const p = conversationPath(directories, id);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * Lists non-archived conversations for a user, sorted by most recently updated first.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} owner_id
 * @returns {Conversation[]}
 */
export function listConversations(directories, owner_id) {
    const dir = path.join(getOpenParlorRoot(directories), 'conversations');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
        .filter(c => c.owner_id === owner_id && !c.archived)
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
    const updated = { ...existing, ...updates, id: existing.id, created_at: existing.created_at, updated_at: new Date().toISOString() };
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
 * Reads all messages for a conversation.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} conversation_id
 * @returns {Message[]}
 */
export function getMessages(directories, conversation_id) {
    const msgPath = conversationMessagesPath(directories, conversation_id);
    if (!fs.existsSync(msgPath)) return [];
    const lines = fs.readFileSync(msgPath, 'utf8').split('\n').filter(Boolean);
    return lines.map(line => JSON.parse(line));
}

// ─── Memory ──────────────────────────────────────────────────────────────────

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} id
 * @returns {string}
 */
function memoryPath(directories, id) {
    return path.join(getOpenParlorRoot(directories), 'memories', `${id}.json`);
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
    /** @type {Memory} */
    const memory = {
        id: crypto.randomUUID(),
        character_id: data.character_id ?? '',
        conversation_id: data.conversation_id ?? null,
        content: data.content ?? '',
        importance: data.importance ?? 0.5,
        owner_id,
        created_at: now,
        updated_at: now,
    };
    writeFileAtomicSync(memoryPath(directories, memory.id), JSON.stringify(memory, null, 2));
    return memory;
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} id
 * @returns {Memory|null}
 */
export function getMemory(directories, id) {
    const p = memoryPath(directories, id);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} owner_id
 * @param {string} [character_id]
 * @returns {Memory[]}
 */
export function listMemories(directories, owner_id, character_id) {
    const dir = path.join(getOpenParlorRoot(directories), 'memories');
    if (!fs.existsSync(dir)) return [];
    let memories = fs.readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
        .filter(m => m.owner_id === owner_id);
    if (character_id) {
        memories = memories.filter(m => m.character_id === character_id);
    }
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
    const updated = { ...existing, ...updates, id: existing.id, created_at: existing.created_at, updated_at: new Date().toISOString() };
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
    return path.join(getOpenParlorRoot(directories), 'settings.json');
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} owner_id
 * @returns {UserOpenParlorSettings}
 */
export function getSettings(directories, owner_id) {
    const p = settingsPath(directories);
    if (!fs.existsSync(p)) {
        return { owner_id, updated_at: new Date().toISOString() };
    }
    return JSON.parse(fs.readFileSync(p, 'utf8'));
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
