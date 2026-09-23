// ─── OpenParlor character card import/export (QWEN-STAB-009) ──────────────────
// Pure (no express) logic for turning untrusted character-card payloads into
// validated OpenParlor character data, and building export cards.
//
// Card shapes:
// - Real SillyTavern Tavern Card V2/V3 payloads nest every character-facing
//   field in a `data` object:
//     { spec: "chara_card_v2" | "chara_card_v3", spec_version, data: { name, ... } }
//   When a `data` object is present it is the authoritative field source
//   (matching upstream SillyTavern's import path, which reads `data.*`).
// - Legacy V1-style cards, and cards produced by earlier OpenParlor exports,
//   keep all fields at the top level and continue to import unchanged.
//
// Security model:
// - Every imported value is untrusted input. Only a fixed allow-list of
//   character-facing fields is ever mapped; every mapped field is type-checked
//   and length-bounded.
// - Imported data can never configure providers, endpoints, filesystem
//   locations, commands, or any other privileged setting. Card fields that
//   look like configuration (baseUrl, provider, pythonExecutable, ...) are
//   ignored, not mapped.
// - OpenParlor's per-character metadata lives in the Tavern Card spec's
//   standard client extension slot (`data.extensions.openparlor`). The legacy
//   top-level `openparlor` object is still accepted for backward
//   compatibility; the standard slot wins per key when both are present.
// - `avatar_url` (or any path/URL) from a card is never trusted. Avatars are
//   only accepted as image bytes: PNG file bytes for PNG cards, or a
//   base64/data-URI payload whose decoded bytes are magic-byte verified.

import { Buffer } from 'node:buffer';

import { read as readPngCard } from '../character-card-parser.js';

export const MAX_CARD_TEXT_LENGTH = 20_000;
export const MAX_CARD_TAGS = 50;
export const MAX_CARD_TAG_LENGTH = 100;
export const MAX_CARD_AVATAR_BYTES = 5 * 1024 * 1024;
// Base64 inflates by ~4/3; keep a margin above the decoded limit so oversized
// payloads are rejected before decoding.
export const MAX_CARD_AVATAR_SOURCE_LENGTH = 8 * 1024 * 1024;

const TEMPERATURE_MIN = 0;
const TEMPERATURE_MAX = 2;
const MAX_TOKENS_MIN = 1;
const MAX_TOKENS_MAX = 8192;
const TTS_VOICE_MAX_LENGTH = 200;

/**
 * @typedef {Object} ImageFormat
 * @property {string} extension File extension without dot
 * @property {string} mime MIME type
 */

/**
 * @typedef {Object} ParsedCard
 * @property {Record<string, unknown>} card Parsed card JSON object
 * @property {Buffer|null} imageBytes PNG bytes when the card arrived inside a PNG
 */

const IMAGE_SIGNATURES = /** @type {Array<[string, ImageFormat]>} */ ([
    ['\x89PNG\r\n\x1a\n', { extension: 'png', mime: 'image/png' }],
    ['GIF87a', { extension: 'gif', mime: 'image/gif' }],
    ['GIF89a', { extension: 'gif', mime: 'image/gif' }],
    ['BM', { extension: 'bmp', mime: 'image/bmp' }],
]);

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4E, 0x47]);

/**
 * Detects an image format from magic bytes. Never trusts file names,
 * extensions, or declared content types.
 * @param {Buffer} buffer Image bytes
 * @returns {ImageFormat|null} The detected format, or null when not a known image
 */
export function detectImageFormat(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 2) return null;
    for (const [signature, format] of IMAGE_SIGNATURES) {
        if (buffer.subarray(0, signature.length).toString('latin1') === signature) return format;
    }
    if (buffer.length > 3 && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
        return { extension: 'jpg', mime: 'image/jpeg' };
    }
    if (buffer.length > 11
        && buffer.subarray(0, 4).toString('latin1') === 'RIFF'
        && buffer.subarray(8, 12).toString('latin1') === 'WEBP') {
        return { extension: 'webp', mime: 'image/webp' };
    }
    return null;
}

/**
 * Returns true when the buffer starts with a PNG signature.
 * @param {Buffer} buffer Bytes to inspect
 * @returns {boolean}
 */
function isPng(buffer) {
    return Buffer.isBuffer(buffer) && buffer.length >= 4
        && buffer.subarray(0, 4).equals(PNG_MAGIC);
}

/**
 * Decodes a card avatar payload (v3 `avatar` field) into verified image bytes.
 * Accepts a `data:...;base64,` URI or a raw base64 string. The declared media
 * type is ignored; the decoded bytes must magic-byte match a known image.
 * @param {unknown} raw Raw card `avatar` value
 * @returns {{ buffer: Buffer } | { error: string }}
 */
export function decodeCardAvatar(raw) {
    if (typeof raw !== 'string' || raw.length === 0) {
        return { error: '"avatar" must be a non-empty base64 or data-URI string' };
    }
    if (raw.length > MAX_CARD_AVATAR_SOURCE_LENGTH) {
        return { error: '"avatar" is too large' };
    }
    let payload = raw;
    if (raw.startsWith('data:')) {
        const comma = raw.indexOf(',');
        if (comma < 0) return { error: '"avatar" data URI is malformed' };
        const header = raw.slice(5, comma).toLowerCase();
        if (!header.endsWith(';base64')) {
            return { error: '"avatar" data URI must be base64-encoded' };
        }
        payload = raw.slice(comma + 1);
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload) || payload.length % 4 === 1) {
        return { error: '"avatar" is not valid base64' };
    }
    let buffer;
    try {
        buffer = Buffer.from(payload, 'base64');
    } catch {
        return { error: '"avatar" is not valid base64' };
    }
    if (buffer.length === 0 || buffer.length > MAX_CARD_AVATAR_BYTES) {
        return { error: '"avatar" is too large' };
    }
    if (!detectImageFormat(buffer)) {
        return { error: '"avatar" does not contain a supported image' };
    }
    return { buffer };
}

/**
 * Parses a raw card upload (JSON text or a PNG with embedded card metadata)
 * into a card object. Both inputs are untrusted; anything that is not a JSON
 * object is rejected.
 * @param {Buffer} buffer Uploaded file bytes
 * @returns {{ card: Record<string, unknown>, imageBytes: Buffer | null } | { error: string }}
 */
export function parseCardBuffer(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        return { error: 'A character card file is required' };
    }
    const head = buffer.subarray(0, 1024).toString('utf8').trimStart();
    if (head.startsWith('{')) {
        let card;
        try {
            card = JSON.parse(buffer.toString('utf8'));
        } catch {
            return { error: 'Card JSON is malformed' };
        }
        if (card === null || typeof card !== 'object' || Array.isArray(card)) {
            return { error: 'Card JSON must be an object' };
        }
        return { card: /** @type {Record<string, unknown>} */ (card), imageBytes: null };
    }
    if (isPng(buffer)) {
        let cardText;
        try {
            cardText = readPngCard(buffer);
        } catch {
            return { error: 'PNG contains no readable character card metadata' };
        }
        let card;
        try {
            card = JSON.parse(cardText);
        } catch {
            return { error: 'PNG card metadata is not valid JSON' };
        }
        if (card === null || typeof card !== 'object' || Array.isArray(card)) {
            return { error: 'PNG card metadata must be a JSON object' };
        }
        return { card: /** @type {Record<string, unknown>} */ (card), imageBytes: buffer };
    }
    return { error: 'Unsupported card format. Use a JSON card or a PNG with card metadata.' };
}

/**
 * Reads a bounded string field from a card, rejecting non-strings and
 * oversize values.
 * @param {Record<string, unknown>} card Card object
 * @param {string} key Field name
 * @param {string} label Human-readable label for errors
 * @returns {{ value: string } | { error: string }}
 */
function readBoundedString(card, key, label) {
    const value = card[key];
    if (value === undefined) return { value: '' };
    if (typeof value !== 'string' || value.length > MAX_CARD_TEXT_LENGTH) {
        return { error: `"${label}" must be a string up to ${MAX_CARD_TEXT_LENGTH} characters` };
    }
    return { value };
}

/**
 * Reads the card tag list (v2: string array; v3: string array or
 * comma-separated string) into bounded, trimmed, de-duplicated strings.
 * @param {Record<string, unknown>} card Card object
 * @returns {{ value: string[] } | { error: string }}
 */
function readTags(card) {
    const raw = card.tags;
    if (raw === undefined) return { value: [] };
    let list;
    if (Array.isArray(raw)) {
        list = raw;
    } else if (typeof raw === 'string') {
        list = raw.split(',');
    } else {
        return { error: '"tags" must be an array of strings or a comma-separated string' };
    }
    const tags = [];
    for (const entry of list) {
        if (typeof entry !== 'string') {
            return { error: '"tags" must be an array of strings or a comma-separated string' };
        }
        const tag = entry.trim();
        if (tag === '' || tag.length > MAX_CARD_TAG_LENGTH) continue;
        if (!tags.includes(tag)) tags.push(tag);
        if (tags.length > MAX_CARD_TAGS) {
            return { error: `"tags" must contain at most ${MAX_CARD_TAGS} tags` };
        }
    }
    return { value: tags };
}

/**
 * Reads the optional OpenParlor-specific extension (`openparlor`) from a card.
 * Only per-character generation settings are accepted, with the exact same
 * bounds as the character create endpoint. Provider configuration is never
 * read from this field.
 * @param {unknown} extension Raw extension value
 * @returns {{ value: Record<string, unknown> } | { error: string }}
 */
function readOpenParlorExtension(extension) {
    if (extension === undefined) return { value: {} };
    if (extension === null || typeof extension !== 'object' || Array.isArray(extension)) {
        return { error: '"openparlor" must be an object' };
    }
    const source = /** @type {Record<string, unknown>} */ (extension);
    /** @type {Record<string, unknown>} */
    const value = {};
    if (source.temperature !== undefined) {
        if (typeof source.temperature !== 'number' || !Number.isFinite(source.temperature)
            || source.temperature < TEMPERATURE_MIN || source.temperature > TEMPERATURE_MAX) {
            return { error: '"openparlor.temperature" must be a number between 0 and 2' };
        }
        value.temperature = source.temperature;
    }
    if (source.max_tokens !== undefined) {
        if (typeof source.max_tokens !== 'number' || !Number.isInteger(source.max_tokens)
            || source.max_tokens < MAX_TOKENS_MIN || source.max_tokens > MAX_TOKENS_MAX) {
            return { error: '"openparlor.max_tokens" must be a positive integer up to 8192' };
        }
        value.max_tokens = source.max_tokens;
    }
    if (source.time_aware !== undefined) {
        if (typeof source.time_aware !== 'boolean') {
            return { error: '"openparlor.time_aware" must be a boolean' };
        }
        value.time_aware = source.time_aware;
    }
    if (source.tts_voice !== undefined) {
        if (typeof source.tts_voice !== 'string' || source.tts_voice.length > TTS_VOICE_MAX_LENGTH) {
            return { error: '"openparlor.tts_voice" must be a string up to 200 characters' };
        }
        value.tts_voice = source.tts_voice;
    }
    return { value };
}

/**
 * True for plain objects (no nulls, no arrays, no other types).
 * @param {unknown} value Value to test
 * @returns {boolean}
 */
function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Resolves the character-facing field source of an untrusted card.
 *
 * Real SillyTavern Tavern Card V2 (`spec: "chara_card_v2"`) and V3
 * (`spec: "chara_card_v3"`) payloads nest the character fields in a `data`
 * object; when a `data` object is present it is the authoritative field
 * source (it also wins over duplicated top-level fields in hybrid files,
 * matching upstream SillyTavern's `readFromV2` import path). Legacy V1-style
 * cards and cards produced by earlier OpenParlor exports keep every field at
 * the top level and continue to work unchanged.
 * @param {Record<string, unknown>} card Parsed card object
 * @returns {{ source: Record<string, unknown>, data: Record<string, unknown> | null }}
 */
function resolveCardFields(card) {
    const data = isPlainObject(card.data)
        ? /** @type {Record<string, unknown>} */ (card.data)
        : null;
    const source = data ? { ...card, ...data } : card;
    return { source, data };
}

/**
 * Normalizes an untrusted card object into a storage-safe OpenParlor
 * character create payload. Works for legacy top-level (V1-style) cards and
 * for nested Tavern Card V2/V3 cards, whose character-facing fields live in
 * `data` (name, description, personality, scenario, first_mes, mes_example /
 * example_dialogue, system_prompt, tags, avatar, ...). Returns only
 * allow-listed fields; unknown card fields are ignored. OpenParlor
 * per-character metadata is read from the spec's standard client extension
 * slot (`data.extensions.openparlor`), with the legacy top-level `openparlor`
 * object still accepted for backward compatibility. When a decodable `avatar`
 * is present, its verified image bytes are returned under `avatarBuffer`;
 * `fallbackName` is used only when the card carries no usable name.
 * @param {unknown} card Parsed card object
 * @param {string} [fallbackName] Name fallback (e.g. the uploaded PNG file name)
 * @returns {{ value: Record<string, unknown>, avatarBuffer: Buffer | null } | { error: string }}
 */
export function normalizeCardCharacter(card, fallbackName = '') {
    if (card === null || typeof card !== 'object' || Array.isArray(card)) {
        return { error: 'Character data must be an object' };
    }
    const { source, data } = resolveCardFields(/** @type {Record<string, unknown>} */ (card));

    const nameResult = readBoundedString(source, 'name', 'name');
    if ('error' in nameResult) return nameResult;
    let name = nameResult.value.trim();
    if (name === '') {
        name = typeof fallbackName === 'string' ? fallbackName.trim() : '';
        if (name === '' || name.length > MAX_CARD_TEXT_LENGTH) {
            return { error: '"name" is required and must not be empty' };
        }
    }

    /** @type {Record<string, unknown>} */
    const value = { name };
    for (const [key, label] of [
        ['description', 'description'],
        ['personality', 'personality'],
        ['scenario', 'scenario'],
        ['first_mes', 'first message'],
        ['system_prompt', 'system prompt'],
    ]) {
        const result = readBoundedString(source, key, label);
        if ('error' in result) return result;
        const mappedKey = key === 'first_mes' ? 'first_message' : key;
        if (result.value !== '') value[mappedKey] = result.value;
    }

    // v2 cards use `mes_example`, v3 cards use `example_dialogue`.
    const dialogue = source.example_dialogue !== undefined ? source.example_dialogue : source.mes_example;
    if (dialogue !== undefined) {
        if (typeof dialogue !== 'string' || dialogue.length > MAX_CARD_TEXT_LENGTH) {
            return { error: `"example dialogue" must be a string up to ${MAX_CARD_TEXT_LENGTH} characters` };
        }
        if (dialogue !== '') value.example_dialogue = dialogue;
    }

    const tagsResult = readTags(source);
    if ('error' in tagsResult) return tagsResult;
    if (tagsResult.value.length > 0) value.tags = tagsResult.value;

    // OpenParlor per-character metadata belongs in the Tavern Card spec's
    // standard client extension slot (`data.extensions.openparlor`). The
    // legacy top-level `openparlor` object produced by earlier OpenParlor
    // exports is still accepted; when both are present the standard slot wins
    // per key. A non-standard `data.openparlor` object is neither location,
    // so it is ignored.
    const legacyExtension = /** @type {Record<string, unknown>} */ (card).openparlor;
    const properExtension = data !== null && isPlainObject(data.extensions)
        ? /** @type {Record<string, unknown>} */ (data.extensions).openparlor
        : undefined;
    let extensionSource = legacyExtension;
    if (properExtension !== undefined) {
        extensionSource = isPlainObject(legacyExtension) && isPlainObject(properExtension)
            ? { ...legacyExtension, ...properExtension }
            : properExtension;
    }
    const extension = readOpenParlorExtension(extensionSource);
    if ('error' in extension) return extension;
    Object.assign(value, extension.value);

    let avatarBuffer = null;
    if (source.avatar !== undefined) {
        const decoded = decodeCardAvatar(source.avatar);
        if ('error' in decoded) return decoded;
        avatarBuffer = decoded.buffer;
    }
    // Note: any `avatar_url` (or other URL/path) field in the card is
    // deliberately ignored — imported paths are never trusted.

    return { value, avatarBuffer };
}

/**
 * Builds a genuinely valid Tavern Card V3 export for an OpenParlor character.
 * The card follows the upstream SillyTavern spec shape: top-level `spec` and
 * `spec_version`, with every character-facing field inside the `data` object.
 * Safe required/default values are populated so the card stays compatible
 * with the upstream SillyTavern TavernCardValidator and import path.
 * OpenParlor's per-character settings go in the spec's standard client
 * extension slot (`data.extensions.openparlor`) — never at the card top
 * level and never as character-facing data.
 * @param {Record<string, unknown>} character Persisted character
 * @param {string|null} avatarDataUri Verified avatar data URI, or null
 * @returns {Record<string, unknown>} Export card object
 */
export function buildExportCard(character, avatarDataUri) {
    /** @param {string} key */
    const str = (key) => (typeof character[key] === 'string' ? character[key] : '');

    /** @type {Record<string, unknown>} */
    const openparlor = {};
    if (typeof character.temperature === 'number' && Number.isFinite(character.temperature)) {
        openparlor.temperature = character.temperature;
    }
    if (typeof character.max_tokens === 'number' && Number.isFinite(character.max_tokens)) {
        openparlor.max_tokens = character.max_tokens;
    }
    if (typeof character.time_aware === 'boolean') openparlor.time_aware = character.time_aware;
    if (typeof character.tts_voice === 'string' && character.tts_voice !== '') {
        openparlor.tts_voice = character.tts_voice;
    }

    /** @type {Record<string, unknown>} */
    const data = {
        name: str('name'),
        description: str('description'),
        personality: str('personality'),
        scenario: str('scenario'),
        first_mes: str('first_message'),
        system_prompt: str('system_prompt'),
        post_history_instructions: '',
        creator_notes: '',
        creator: '',
        character_version: '',
        example_dialogue: str('example_dialogue'),
        alternate_greetings: [],
        tags: Array.isArray(character.tags) ? character.tags.filter(tag => typeof tag === 'string') : [],
        extensions: Object.keys(openparlor).length > 0 ? { openparlor } : {},
    };
    if (avatarDataUri) data.avatar = avatarDataUri;

    return {
        spec: 'chara_card_v3',
        spec_version: '3.0',
        data,
    };
}

/**
 * Builds a safe Content-Disposition file name for a card export.
 * @param {string} characterName Character name
 * @returns {string} File name ending in .json
 */
export function buildCardFilename(characterName) {
    const base = (typeof characterName === 'string' ? characterName : '').trim();
    const safe = base.replace(/[^\p{L}\p{N} _-]/gu, '').trim().replace(/\s+/g, '_');
    return (safe || 'character').slice(0, 100) + '.json';
}
