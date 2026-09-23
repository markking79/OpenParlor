// ─── QWEN-STAB-009: character card import/export ─────────────────────────────
// Unit tests for the untrusted-card logic (parse/normalize/export) plus
// integration tests for the HTTP import/export routes against the real
// persistence layer in a temp directory.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

import { createOpenParlorCharacterRouter } from '../../src/openparlor/character-router.js';
import * as realPersistence from '../../src/openparlor/persistence.js';
import {
    buildCardFilename,
    buildExportCard,
    decodeCardAvatar,
    detectImageFormat,
    normalizeCardCharacter,
    parseCardBuffer,
    MAX_CARD_AVATAR_BYTES,
    MAX_CARD_AVATAR_SOURCE_LENGTH,
} from '../../src/openparlor/character-card.js';
import { write as writePngCard } from '../../src/character-card-parser.js';
import { TavernCardValidator } from '../../src/validator/TavernCardValidator.js';

// Minimal 1x1 PNG.
const PNG_1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
);

const mockTtsProvider = {
    listVoices: () => ['af_heart', 'bf_emma'],
};

/**
 * Builds a PNG card with embedded v2/v3 metadata.
 * @param {Record<string, unknown>} card Card object
 * @param {Buffer} [image] Base PNG image
 * @returns {Buffer}
 */
function pngCard(card, image = PNG_1x1) {
    return writePngCard(image, JSON.stringify(card));
}

/**
 * A real nested Tavern Card V2 fixture, shaped exactly like the cards
 * SillyTavern writes and imports: top-level spec/spec_version plus a nested
 * `data` object carrying all character-facing fields.
 * @param {Record<string, unknown>} [data] Overrides for the nested data object
 * @returns {Record<string, unknown>}
 */
function v2Card(data = {}) {
    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: 'V2 Hero',
            description: 'a v2 character',
            personality: 'brave',
            scenario: 'a quest',
            first_mes: 'Greetings, traveler!',
            mes_example: 'Hero: onward\nGuide: stay close',
            creator_notes: 'internal notes',
            system_prompt: 'You are a hero.',
            post_history_instructions: '',
            alternate_greetings: ['A different greeting'],
            tags: ['fantasy', 'hero'],
            creator: 'card-tester',
            character_version: '1.0',
            extensions: {},
            ...data,
        },
    };
}

/**
 * A real nested Tavern Card V3 fixture (spec chara_card_v3, spec_version
 * 3.0, character fields in `data`, example_dialogue instead of mes_example).
 * @param {Record<string, unknown>} [data] Overrides for the nested data object
 * @returns {Record<string, unknown>}
 */
function v3Card(data = {}) {
    return {
        spec: 'chara_card_v3',
        spec_version: '3.0',
        data: {
            name: 'V3 Hero',
            description: 'a v3 character',
            personality: 'curious',
            scenario: 'a tavern',
            first_mes: 'Hello!',
            system_prompt: 'You are a hero.',
            post_history_instructions: '',
            creator_notes: '',
            creator: 'card-tester',
            character_version: '1.0',
            example_dialogue: 'Hero: hi\nGuide: hello',
            alternate_greetings: [],
            tags: ['fantasy'],
            extensions: {},
            ...data,
        },
    };
}

/**
 * @param {Buffer} bytes
 * @returns {FormData}
 */
function cardUpload(bytes, filename, contentType) {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: contentType }), filename);
    return form;
}

/**
 * @param {Record<string, unknown>} card
 * @returns {FormData}
 */
function jsonUpload(card) {
    return cardUpload(Buffer.from(JSON.stringify(card), 'utf8'), 'card.json', 'application/json');
}

/**
 * Creates a fresh temp user directory (root + userImages under it).
 * @returns {{ root: string, directories: object }}
 */
function makeRealDirs() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openparlor-card-'));
    return {
        root,
        directories: {
            root,
            userImages: path.join(root, 'user', 'images'),
        },
    };
}

/**
 * @param {object} directories
 * @param {{ profile: { handle: string } }|null} user
 * @param {object} [ttsProvider]
 * @returns {import('express').Express}
 */
function createTestApp(directories, user, ttsProvider = mockTtsProvider) {
    const app = express();
    app.use(express.json());
    if (user) {
        app.use((req, _res, next) => {
            req.user = user;
            next();
        });
    }
    app.use('/api/openparlor/characters',
        createOpenParlorCharacterRouter({ persistence: realPersistence, ttsProvider }));
    return app;
}

/**
 * @param {import('express').Express} app
 * @returns {Promise<{ server: import('http').Server, baseUrl: string }>}
 */
function startServer(app) {
    return new Promise((resolve) => {
        const server = http.createServer(app);
        server.listen(0, '127.0.0.1', () => {
            const { port } = /** @type {import('net').AddressInfo} */ (server.address());
            resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
        });
    });
}


// ─── Unit: image format detection ────────────────────────────────────────────

describe('detectImageFormat', () => {
    it('detects PNG from magic bytes', () => {
        assert.deepEqual(detectImageFormat(PNG_1x1), { extension: 'png', mime: 'image/png' });
    });

    it('detects JPEG, GIF, WebP, and BMP', () => {
        const jpeg = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(8, 0)]);
        assert.equal(detectImageFormat(jpeg)?.mime, 'image/jpeg');
        assert.equal(detectImageFormat(Buffer.from('GIF89a' + 'x'.repeat(8)))?.mime, 'image/gif');
        const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(8)]);
        assert.equal(detectImageFormat(webp)?.mime, 'image/webp');
        assert.equal(detectImageFormat(Buffer.from('BM' + 'x'.repeat(8)))?.mime, 'image/bmp');
    });

    it('rejects non-image bytes', () => {
        assert.equal(detectImageFormat(Buffer.from('not an image')), null);
        assert.equal(detectImageFormat(Buffer.alloc(0)), null);
        assert.equal(detectImageFormat(Buffer.from('PNGGARBAGE')), null);
    });
});

// ─── Unit: parseCardBuffer ───────────────────────────────────────────────────

describe('parseCardBuffer', () => {
    it('parses a JSON object card', () => {
        const result = parseCardBuffer(Buffer.from('{"name":"Alice","tags":["a"]}', 'utf8'));
        assert.ok('card' in result);
        assert.equal(/** @type {{ card: object }} */ (result).card.name, 'Alice');
        assert.equal(/** @type {{ imageBytes: object }} */ (result).imageBytes, null);
    });

    it('parses JSON with leading whitespace and BOM-free text', () => {
        const result = parseCardBuffer(Buffer.from('\n  {"name":"Bob"}', 'utf8'));
        assert.ok('card' in result);
        assert.equal(/** @type {{ card: object }} */ (result).card.name, 'Bob');
    });

    it('rejects a JSON array', () => {
        const result = parseCardBuffer(Buffer.from('[1,2,3]', 'utf8'));
        assert.ok('error' in result);
    });

    it('rejects malformed JSON', () => {
        const result = parseCardBuffer(Buffer.from('{"name":', 'utf8'));
        assert.ok('error' in result);
    });

    it('parses a PNG card with embedded chara metadata', () => {
        const card = pngCard({ name: 'Png Char', first_mes: 'Hello!' });
        const result = parseCardBuffer(card);
        assert.ok('card' in result);
        assert.equal(/** @type {{ card: object }} */ (result).card.name, 'Png Char');
        assert.ok(Buffer.isBuffer(/** @type {{ imageBytes: Buffer }} */ (result).imageBytes));
    });

    it('rejects a PNG without card metadata', () => {
        const result = parseCardBuffer(PNG_1x1);
        assert.ok('error' in result);
    });

    it('rejects unsupported bytes and empty uploads', () => {
        assert.ok('error' in parseCardBuffer(Buffer.from('plain text file', 'utf8')));
        assert.ok('error' in parseCardBuffer(Buffer.alloc(0)));
    });
});

// ─── Unit: decodeCardAvatar ──────────────────────────────────────────────────

describe('decodeCardAvatar', () => {
    it('decodes a PNG data URI into the original bytes', () => {
        const dataUri = `data:image/png;base64,${PNG_1x1.toString('base64')}`;
        const result = decodeCardAvatar(dataUri);
        assert.ok('buffer' in result);
        assert.deepEqual(/** @type {{ buffer: Buffer }} */ (result).buffer, PNG_1x1);
    });

    it('decodes raw base64 without a data URI prefix', () => {
        const result = decodeCardAvatar(PNG_1x1.toString('base64'));
        assert.ok('buffer' in result);
    });

    it('rejects non-base64 data URIs', () => {
        assert.ok('error' in decodeCardAvatar('data:text/html,<script>'));
        assert.ok('error' in decodeCardAvatar('data:image/png;'));
    });

    it('rejects base64 that decodes to non-image bytes', () => {
        const html = Buffer.from('<html>evil</html>').toString('base64');
        assert.ok('error' in decodeCardAvatar(`data:image/png;base64,${html}`));
    });

    it('rejects invalid base64 payloads', () => {
        assert.ok('error' in decodeCardAvatar('!!!not-base64!!!'));
        assert.ok('error' in decodeCardAvatar('AAAAA')); // length % 4 === 1
        assert.ok('error' in decodeCardAvatar(''));
        assert.ok('error' in decodeCardAvatar(null));
        assert.ok('error' in decodeCardAvatar(42));
    });

    it('rejects oversize payloads before decoding', () => {
        const huge = 'A'.repeat(MAX_CARD_AVATAR_SOURCE_LENGTH + 1);
        const result = decodeCardAvatar(huge);
        assert.ok('error' in result);
        assert.match(/** @type {{ error: string }} */ (result).error, /too large/);
    });

    it('rejects decoded bytes above the 5 MB cap', () => {
        const oversize = Buffer.alloc(MAX_CARD_AVATAR_BYTES + 16, 0);
        const result = decodeCardAvatar(oversize.toString('base64'));
        assert.ok('error' in result);
        assert.match(/** @type {{ error: string }} */ (result).error, /too large/);
    });
});
/**
 * @param {import('http').Server} server
 * @returns {Promise<void>}
 */
function stopServer(server) {
    return new Promise((resolve) => server.close(resolve));
}

// ─── Unit: normalizeCardCharacter ────────────────────────────────────────────

describe('normalizeCardCharacter', () => {
    it('maps v3 card fields to character fields', () => {
        const result = normalizeCardCharacter({
            name: 'Alice',
            description: 'desc',
            personality: 'personality',
            scenario: 'scenario',
            first_mes: 'Hi!',
            system_prompt: 'You are Alice.',
            example_dialogue: '<START>\nAlice: Hi',
            tags: ['a', 'b'],
            openparlor: { temperature: 0.7, max_tokens: 1024, time_aware: true, tts_voice: 'af_heart' },
        });
        assert.ok('value' in result);
        const value = /** @type {{ value: object }} */ (result).value;
        assert.equal(value.name, 'Alice');
        assert.equal(value.description, 'desc');
        assert.equal(value.personality, 'personality');
        assert.equal(value.scenario, 'scenario');
        assert.equal(value.first_message, 'Hi!');
        assert.equal(value.system_prompt, 'You are Alice.');
        assert.equal(value.example_dialogue, '<START>\nAlice: Hi');
        assert.deepEqual(value.tags, ['a', 'b']);
        assert.equal(value.temperature, 0.7);
        assert.equal(value.max_tokens, 1024);
        assert.equal(value.time_aware, true);
        assert.equal(value.tts_voice, 'af_heart');
        assert.equal(/** @type {{ avatarBuffer: Buffer }} */ (result).avatarBuffer, null);
    });

    it('maps v2 card fields (mes_example, first_mes, tags array)', () => {
        const result = normalizeCardCharacter({
            name: 'V2 Bot',
            description: 'old style',
            first_mes: 'Hello there',
            mes_example: 'X: hi\nV2: yo',
            tags: ['retro'],
        });
        assert.ok('value' in result);
        const value = /** @type {{ value: object }} */ (result).value;
        assert.equal(value.first_message, 'Hello there');
        assert.equal(value.example_dialogue, 'X: hi\nV2: yo');
        assert.deepEqual(value.tags, ['retro']);
    });

    it('imports a real nested V2 card (spec chara_card_v2) from data', () => {
        const card = v2Card({
            extensions: { talkativeness: 0.9, openparlor: { temperature: 0.4, max_tokens: 256 } },
        });
        const result = normalizeCardCharacter(card);
        assert.ok('value' in result);
        const value = /** @type {{ value: Record<string, unknown> }} */ (result).value;
        assert.equal(value.name, 'V2 Hero');
        assert.equal(value.description, 'a v2 character');
        assert.equal(value.personality, 'brave');
        assert.equal(value.scenario, 'a quest');
        assert.equal(value.first_message, 'Greetings, traveler!');
        assert.equal(value.system_prompt, 'You are a hero.');
        assert.equal(value.example_dialogue, 'Hero: onward\nGuide: stay close');
        assert.deepEqual(value.tags, ['fantasy', 'hero']);
        assert.equal(value.temperature, 0.4);
        assert.equal(value.max_tokens, 256);
        assert.equal(/** @type {{ avatarBuffer: Buffer | null }} */ (result).avatarBuffer, null);
        // Spec-only fields that OpenParlor does not model are not imported.
        assert.equal(value.creator, undefined);
        assert.equal(value.creator_notes, undefined);
        assert.equal(value.post_history_instructions, undefined);
        assert.equal(value.alternate_greetings, undefined);
        assert.equal(value.character_version, undefined);
        assert.equal(value.talkativeness, undefined);
    });

    it('imports a real nested V3 card (spec chara_card_v3) from data', () => {
        const card = v3Card({ example_dialogue: 'V3: hello', tags: 'a, b' });
        const result = normalizeCardCharacter(card);
        assert.ok('value' in result);
        const value = /** @type {{ value: Record<string, unknown> }} */ (result).value;
        assert.equal(value.name, 'V3 Hero');
        assert.equal(value.description, 'a v3 character');
        assert.equal(value.first_message, 'Hello!');
        assert.equal(value.example_dialogue, 'V3: hello');
        assert.deepEqual(value.tags, ['a', 'b']);
    });

    it('prefers nested data fields over duplicated top-level fields (hybrid ST files)', () => {
        const card = v2Card({ name: 'Nested Name' });
        card.name = 'Top Level Name';
        card.description = 'top description';
        const result = normalizeCardCharacter(card);
        assert.ok('value' in result);
        assert.equal(/** @type {{ value: object }} */ (result).value.name, 'Nested Name');
        assert.equal(result.value.description, 'a v2 character');
    });

    it('reads OpenParlor metadata from the standard data.extensions.openparlor slot', () => {
        const card = v3Card({
            extensions: {
                talkativeness: 0.9,
                openparlor: { temperature: 1.1, time_aware: true, tts_voice: 'bf_emma' },
            },
        });
        const result = normalizeCardCharacter(card);
        assert.ok('value' in result);
        const value = /** @type {{ value: Record<string, unknown> }} */ (result).value;
        assert.equal(value.temperature, 1.1);
        assert.equal(value.time_aware, true);
        assert.equal(value.tts_voice, 'bf_emma');
        assert.equal(value.talkativeness, undefined);
    });

    it('accepts the legacy top-level openparlor extension; the standard slot wins per key', () => {
        const card = v2Card({ extensions: { openparlor: { temperature: 0.2, max_tokens: 128 } } });
        card.openparlor = { temperature: 0.9, max_tokens: 128, tts_voice: 'af_heart' };
        const result = normalizeCardCharacter(card);
        assert.ok('value' in result);
        const value = /** @type {{ value: Record<string, unknown> }} */ (result).value;
        assert.equal(value.temperature, 0.2); // standard slot wins
        assert.equal(value.max_tokens, 128); // both agree
        assert.equal(value.tts_voice, 'af_heart'); // legacy-only key still read
    });

    it('ignores a non-standard data.openparlor object', () => {
        const card = v3Card({ openparlor: { temperature: 0.1 } });
        delete card.data.extensions; // no standard extension slot
        const result = normalizeCardCharacter(card);
        assert.ok('value' in result);
        assert.equal(/** @type {{ value: Record<string, unknown> }} */ (result).value.temperature, undefined);
    });

    it('still imports legacy top-level (V1-style) cards with the legacy extension', () => {
        const result = normalizeCardCharacter({
            name: 'Legacy',
            description: 'pre-spec',
            first_mes: 'hi',
            mes_example: 'L: yo',
            openparlor: { time_aware: true },
        });
        assert.ok('value' in result);
        const value = /** @type {{ value: Record<string, unknown> }} */ (result).value;
        assert.equal(value.name, 'Legacy');
        assert.equal(value.first_message, 'hi');
        assert.equal(value.example_dialogue, 'L: yo');
        assert.equal(value.time_aware, true);
    });

    it('still imports cards produced by the earlier OpenParlor export (003e04730 top-level shape)', () => {
        const legacyExport = {
            spec: 'chara_card_v3',
            spec_version: '3.0',
            name: 'Old Export',
            description: 'legacy shape',
            first_mes: 'hi',
            example_dialogue: 'OE: yo',
            tags: ['legacy'],
            avatar: `data:image/png;base64,${PNG_1x1.toString('base64')}`,
            openparlor: { temperature: 0.5, max_tokens: 64, time_aware: true, tts_voice: 'af_heart' },
        };
        const result = normalizeCardCharacter(legacyExport);
        assert.ok('value' in result);
        const value = /** @type {{ value: Record<string, unknown> }} */ (result).value;
        assert.equal(value.name, 'Old Export');
        assert.equal(value.description, 'legacy shape');
        assert.equal(value.first_message, 'hi');
        assert.equal(value.example_dialogue, 'OE: yo');
        assert.deepEqual(value.tags, ['legacy']);
        assert.equal(value.temperature, 0.5);
        assert.equal(value.max_tokens, 64);
        assert.equal(value.time_aware, true);
        assert.equal(value.tts_voice, 'af_heart');
        assert.deepEqual(/** @type {{ avatarBuffer: Buffer }} */ (result).avatarBuffer, PNG_1x1);
    });

    it('uses the fallback name only when the card carries no usable name', () => {
        const named = normalizeCardCharacter({ name: '  Card Name  ' }, 'File Name');
        assert.ok('value' in named);
        assert.equal(/** @type {{ value: object }} */ (named).value.name, 'Card Name');
        const unnamed = normalizeCardCharacter({ description: 'no name' }, ' File Name ');
        assert.ok('value' in unnamed);
        assert.equal(/** @type {{ value: object }} */ (unnamed).value.name, 'File Name');
        const nestedUnnamed = normalizeCardCharacter(v3Card({ name: '   ' }), 'Png File');
        assert.ok('value' in nestedUnnamed);
        assert.equal(/** @type {{ value: object }} */ (nestedUnnamed).value.name, 'Png File');
        assert.ok('error' in normalizeCardCharacter({ description: 'no name' }));
        assert.ok('error' in normalizeCardCharacter({}, ''));
    });

    it('ignores privileged and path fields inside nested data (config poisoning)', () => {
        const card = v2Card({
            name: 'Poisoned',
            avatar_url: '/user/images/../../etc/shadow',
            baseUrl: 'http://attacker.example',
            provider: 'evil-provider',
            pythonExecutable: '/bin/sh',
            system: 'SYSTEM OVERRIDE',
            openparlor: { temperature: 0.1, provider: 'evil', apiKey: 'secret' },
        });
        const result = normalizeCardCharacter(card);
        assert.ok('value' in result);
        const value = /** @type {{ value: Record<string, unknown> }} */ (result).value;
        assert.equal(value.name, 'Poisoned');
        for (const key of ['avatar_url', 'baseUrl', 'provider', 'pythonExecutable', 'system', 'apiKey']) {
            assert.equal(value[key], undefined, `unexpected field ${key}`);
        }
        assert.equal(value.temperature, undefined); // non-standard data.openparlor ignored
        assert.equal(/** @type {{ avatarBuffer: Buffer | null }} */ (result).avatarBuffer, null);
    });

    it('accepts v3 comma-separated tags, trimmed and de-duplicated', () => {
        const result = normalizeCardCharacter({ name: 'Taggy', tags: ' a , b , a ,, ' });
        assert.ok('value' in result);
        assert.deepEqual(/** @type {{ value: object }} */ (result).value.tags, ['a', 'b']);
    });

    it('requires a non-empty name', () => {
        assert.ok('error' in normalizeCardCharacter({}));
        assert.ok('error' in normalizeCardCharacter({ name: '   ' }));
        assert.ok('error' in normalizeCardCharacter({ name: 42 }));
    });

    it('bounds text fields', () => {
        assert.ok('error' in normalizeCardCharacter({ name: 'x'.repeat(20_001) }));
        assert.ok('error' in normalizeCardCharacter({ name: 'Ok', description: 'y'.repeat(20_001) }));
        assert.ok('error' in normalizeCardCharacter({ name: 'Ok', first_mes: 123 }));
        assert.ok('error' in normalizeCardCharacter({ name: 'Ok', scenario: { nested: true } }));
        assert.ok('error' in normalizeCardCharacter({ name: 'Ok', example_dialogue: 'z'.repeat(20_001) }));
    });

    it('validates tag lists', () => {
        assert.ok('error' in normalizeCardCharacter({ name: 'Ok', tags: ['a', 1] }));
        assert.ok('error' in normalizeCardCharacter({ name: 'Ok', tags: Array.from({ length: 51 }, (_, i) => `t${i}`) }));
        assert.ok('error' in normalizeCardCharacter({ name: 'Ok', tags: 42 }));
        // Trailing separators are tolerated.
        const trailing = normalizeCardCharacter({ name: 'Ok', tags: 'a, b, ' });
        assert.ok('value' in trailing);
        assert.deepEqual(/** @type {{ value: object }} */ (trailing).value.tags, ['a', 'b']);
        // Oversize individual tags are dropped, not fatal.
        const dropped = normalizeCardCharacter({ name: 'Ok', tags: ['ok', 'x'.repeat(101)] });
        assert.ok('value' in dropped);
        assert.deepEqual(/** @type {{ value: object }} */ (dropped).value.tags, ['ok']);
    });

    it('validates openparlor extension bounds', () => {
        const base = { name: 'Ok' };
        assert.ok('error' in normalizeCardCharacter({ ...base, openparlor: 'nope' }));
        assert.ok('error' in normalizeCardCharacter({ ...base, openparlor: [1] }));
        assert.ok('error' in normalizeCardCharacter({ ...base, openparlor: { temperature: 2.5 } }));
        assert.ok('error' in normalizeCardCharacter({ ...base, openparlor: { temperature: -0.1 } }));
        assert.ok('error' in normalizeCardCharacter({ ...base, openparlor: { temperature: '0.5' } }));
        assert.ok('error' in normalizeCardCharacter({ ...base, openparlor: { max_tokens: 0 } }));
        assert.ok('error' in normalizeCardCharacter({ ...base, openparlor: { max_tokens: 8193 } }));
        assert.ok('error' in normalizeCardCharacter({ ...base, openparlor: { max_tokens: 1.5 } }));
        assert.ok('error' in normalizeCardCharacter({ ...base, openparlor: { time_aware: 'true' } }));
        assert.ok('error' in normalizeCardCharacter({ ...base, openparlor: { tts_voice: 'x'.repeat(201) } }));

        const ok = normalizeCardCharacter({ ...base, openparlor: { temperature: 0, max_tokens: 8192, time_aware: false, tts_voice: '' } });
        assert.ok('value' in ok);
        const value = /** @type {{ value: object }} */ (ok).value;
        assert.equal(value.temperature, 0);
        assert.equal(value.max_tokens, 8192);
        assert.equal(value.time_aware, false);
        assert.equal(value.tts_voice, '');
    });

    it('ignores unknown and privileged card fields (config poisoning)', () => {
        const result = normalizeCardCharacter({
            name: 'Trusted',
            id: 'fixed-id',
            owner_id: 'someone-else',
            archived: true,
            avatar_url: '/etc/passwd',
            baseUrl: 'http://attacker.example',
            provider: 'evil-provider',
            pythonExecutable: '/bin/sh',
            runnerPath: '/tmp/pwn',
            modelPath: '/tmp/model',
            modelCacheDir: '/tmp/cache',
            tts_provider: 'evil',
            system: 'SYSTEM OVERRIDE',
            extend: { provider: { apiKey: 'secret' } },
            creator_notes: 'secret notes',
        });
        assert.ok('value' in result);
        const value = /** @type {{ value: Record<string, unknown> }} */ (result).value;
        assert.deepEqual(Object.keys(value).sort(), ['name']);
        assert.equal(/** @type {{ avatarBuffer: Buffer }} */ (result).avatarBuffer, null);
    });

    it('decodes a card avatar into verified bytes', () => {
        const dataUri = `data:image/png;base64,${PNG_1x1.toString('base64')}`;
        const result = normalizeCardCharacter({ name: 'With Avatar', avatar: dataUri });
        assert.ok('value' in result);
        assert.deepEqual(/** @type {{ avatarBuffer: Buffer }} */ (result).avatarBuffer, PNG_1x1);
        assert.equal(/** @type {{ value: object }} */ (result).value.avatar, undefined);
    });

    it('rejects malformed card avatars and ignores avatar_url', () => {
        const html = Buffer.from('<html>evil</html>').toString('base64');
        const result = normalizeCardCharacter({ name: 'Evil', avatar: `data:image/png;base64,${html}` });
        assert.ok('error' in result);
        // A hostile avatar_url (including traversal) is ignored, never mapped.
        const ignored = normalizeCardCharacter({ name: 'Safe', avatar_url: '/user/images/../../etc/shadow' });
        assert.ok('value' in ignored);
        assert.equal(/** @type {{ value: object }} */ (ignored).value.avatar_url, undefined);
    });
});

// ─── Unit: buildExportCard / buildCardFilename ───────────────────────────────

describe('buildExportCard', () => {
    it('builds a spec-valid nested V3 card from a full character', () => {
        const card = buildExportCard({
            name: 'Alice',
            description: 'desc',
            personality: 'personality',
            scenario: 'scenario',
            first_message: 'Hi!',
            system_prompt: 'You are Alice.',
            example_dialogue: 'Alice: Hello',
            tags: ['a', 'b'],
            temperature: 0.7,
            max_tokens: 1024,
            time_aware: true,
            tts_voice: 'af_heart',
        }, 'data:image/png;base64,AAA=');
        assert.equal(card.spec, 'chara_card_v3');
        assert.equal(card.spec_version, '3.0');
        const data = /** @type {Record<string, unknown>} */ (card.data);
        assert.equal(data.name, 'Alice');
        assert.equal(data.description, 'desc');
        assert.equal(data.personality, 'personality');
        assert.equal(data.scenario, 'scenario');
        assert.equal(data.first_mes, 'Hi!');
        assert.equal(data.system_prompt, 'You are Alice.');
        assert.equal(data.example_dialogue, 'Alice: Hello');
        assert.deepEqual(data.tags, ['a', 'b']);
        assert.equal(data.avatar, 'data:image/png;base64,AAA=');
        // OpenParlor metadata lives in the standard extension slot, not in
        // the character-facing data or at the card top level.
        assert.deepEqual(data.extensions, {
            openparlor: { temperature: 0.7, max_tokens: 1024, time_aware: true, tts_voice: 'af_heart' },
        });
        assert.equal(card.name, undefined);
        assert.equal(card.openparlor, undefined);
        assert.equal(card.avatar, undefined);
        // Genuinely valid per the upstream SillyTavern validator.
        assert.equal(new TavernCardValidator(card).validate(), 3);
    });

    it('populates safe V3 defaults for unset fields', () => {
        const card = buildExportCard({ name: 'Minimal' });
        const data = /** @type {Record<string, unknown>} */ (card.data);
        assert.equal(data.name, 'Minimal');
        assert.equal(data.description, '');
        assert.equal(data.personality, '');
        assert.equal(data.scenario, '');
        assert.equal(data.first_mes, '');
        assert.equal(data.system_prompt, '');
        assert.equal(data.post_history_instructions, '');
        assert.equal(data.creator_notes, '');
        assert.equal(data.creator, '');
        assert.equal(data.character_version, '');
        assert.equal(data.example_dialogue, '');
        assert.deepEqual(data.alternate_greetings, []);
        assert.deepEqual(data.tags, []);
        assert.deepEqual(data.extensions, {});
        assert.equal(data.avatar, undefined);
        assert.equal(new TavernCardValidator(card).validate(), 3);
    });

    it('round-trips the nested export through parseCardBuffer/normalizeCardCharacter', () => {
        const card = buildExportCard({
            name: 'Round Trip',
            description: 'd',
            personality: 'p',
            scenario: 's',
            first_message: 'Hi!',
            system_prompt: 'sp',
            example_dialogue: 'RT: hello',
            tags: ['one', 'two'],
            temperature: 0.3,
            max_tokens: 512,
            time_aware: false,
            tts_voice: 'bf_emma',
        });
        const parsed = parseCardBuffer(Buffer.from(JSON.stringify(card), 'utf8'));
        assert.ok('card' in parsed);
        const normalized = normalizeCardCharacter(/** @type {{ card: object }} */ (parsed).card);
        assert.ok('value' in normalized);
        const value = /** @type {{ value: Record<string, unknown> }} */ (normalized).value;
        assert.equal(value.name, 'Round Trip');
        assert.equal(value.description, 'd');
        assert.equal(value.personality, 'p');
        assert.equal(value.scenario, 's');
        assert.equal(value.first_message, 'Hi!');
        assert.equal(value.system_prompt, 'sp');
        assert.equal(value.example_dialogue, 'RT: hello');
        assert.deepEqual(value.tags, ['one', 'two']);
        assert.equal(value.temperature, 0.3);
        assert.equal(value.max_tokens, 512);
        assert.equal(value.time_aware, false);
        assert.equal(value.tts_voice, 'bf_emma');
    });

    it('filters non-string tags', () => {
        const card = buildExportCard({ name: 'X', tags: ['a', 1, 'b'] });
        assert.deepEqual(/** @type {Record<string, unknown>} */ (card.data).tags, ['a', 'b']);
    });
});

describe('buildCardFilename', () => {
    it('builds a safe .json filename from the name', () => {
        assert.equal(buildCardFilename('My Cool Character'), 'My_Cool_Character.json');
        assert.equal(buildCardFilename('Ünïcodé 名前'), 'Ünïcodé_名前.json');
    });

    it('strips path separators, dots, and other hostile characters', () => {
        assert.equal(buildCardFilename('a/b\\c..json'), 'abcjson.json');
        assert.equal(buildCardFilename('..\\..\\..\\etc\\passwd'), 'etcpasswd.json');
        assert.equal(buildCardFilename('x "quoted" file'), 'x_quoted_file.json');
    });

    it('falls back for empty or fully hostile names', () => {
        assert.equal(buildCardFilename(''), 'character.json');
        assert.equal(buildCardFilename('../../'), 'character.json');
    });

    it('truncates very long names', () => {
        const long = 'x'.repeat(300);
        const result = buildCardFilename(long);
        assert.ok(result.endsWith('.json'));
        assert.ok(result.length < 120);
    });
});

// ─── Integration: POST /import ───────────────────────────────────────────────

describe('character card import (HTTP)', () => {
    let tmpRoot;
    let directories;
    let server;
    let baseUrl;

    beforeEach(async () => {
        ({ root: tmpRoot, directories } = makeRealDirs());
        const app = createTestApp(directories, { directories, profile: { handle: 'alice' } });
        ({ server, baseUrl } = await startServer(app));
    });

    afterEach(async () => {
        if (server) await stopServer(server);
        if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    /**
     * @param {FormData} form
     */
    async function postImport(form) {
        return fetch(`${baseUrl}/api/openparlor/characters/import`, { method: 'POST', body: form });
    }

    it('imports a real nested V3 JSON card (spec chara_card_v3) with an avatar data URI', async () => {
        const card = v3Card({
            name: 'Imported Alice',
            description: 'from a card',
            personality: 'curious',
            scenario: 'a tavern',
            first_mes: 'Hi there!',
            system_prompt: 'You are Alice.',
            example_dialogue: 'Alice: hello',
            tags: 'friendly, witty',
            avatar: `data:image/png;base64,${PNG_1x1.toString('base64')}`,
            extensions: { openparlor: { temperature: 0.7, max_tokens: 1024, time_aware: true, tts_voice: 'af_heart' } },
        });
        const res = await postImport(jsonUpload(card));
        assert.equal(res.status, 201);
        const character = await res.json();
        assert.equal(character.name, 'Imported Alice');
        assert.equal(character.owner_id, 'alice');
        assert.equal(character.tts_voice, 'af_heart');
        assert.match(character.avatar_url, /^\/user\/images\/openparlor-avatar-\d+\.png$/);

        // Avatar stored on disk with verified PNG magic.
        const stored = path.join(tmpRoot, 'user', 'images', path.basename(character.avatar_url));
        assert.ok(fs.existsSync(stored));
        assert.equal(detectImageFormat(fs.readFileSync(stored))?.mime, 'image/png');
    });

    it('imports a real nested V2 PNG card and preserves the card image as the avatar', async () => {
        const card = pngCard(v2Card({
            name: 'Png Hero',
            description: 'in a png',
            first_mes: 'yo',
            mes_example: 'A: hi',
        }));
        const res = await postImport(cardUpload(card, 'hero.png', 'image/png'));
        assert.equal(res.status, 201);
        const character = await res.json();
        assert.equal(character.name, 'Png Hero');
        assert.equal(character.description, 'in a png');
        assert.equal(character.first_message, 'yo');
        assert.equal(character.example_dialogue, 'A: hi');
        // The PNG card image itself becomes the character avatar.
        assert.match(character.avatar_url, /^\/user\/images\/openparlor-avatar-\d+\.png$/);
        const stored = path.join(tmpRoot, 'user', 'images', path.basename(character.avatar_url));
        assert.ok(fs.existsSync(stored));
        assert.equal(detectImageFormat(fs.readFileSync(stored))?.mime, 'image/png');
        assert.deepEqual(fs.readFileSync(stored), card);
    });

    it('prefers the card avatar field over the PNG image when both are present', async () => {
        const gif = Buffer.from('GIF89a' + 'x'.repeat(8)); // magic-byte-valid GIF
        const card = pngCard(v2Card({
            name: 'Dual Avatar',
            avatar: `data:image/gif;base64,${gif.toString('base64')}`,
        }));
        const res = await postImport(cardUpload(card, 'dual.png', 'image/png'));
        assert.equal(res.status, 201);
        const character = await res.json();
        assert.match(character.avatar_url, /^\/user\/images\/openparlor-avatar-\d+\.gif$/);
        const stored = path.join(tmpRoot, 'user', 'images', path.basename(character.avatar_url));
        assert.deepEqual(fs.readFileSync(stored), gif);
    });

    it('stores the avatar field of a legacy top-level PNG card when present', async () => {
        const card = pngCard({
            name: 'Png Avatar',
            avatar: `data:image/png;base64,${PNG_1x1.toString('base64')}`,
        });
        const res = await postImport(cardUpload(card, 'hero.png', 'image/png'));
        assert.equal(res.status, 201);
        const character = await res.json();
        assert.match(character.avatar_url, /\.png$/);
        const stored = path.join(tmpRoot, 'user', 'images', path.basename(character.avatar_url));
        assert.deepEqual(fs.readFileSync(stored), PNG_1x1);
    });

    it('uses the upload file name when the card has no name', async () => {
        const card = pngCard({ description: 'unnamed card' });
        const res = await postImport(cardUpload(card, 'My Hero.png', 'image/png'));
        assert.equal(res.status, 201);
        assert.equal((await res.json()).name, 'My Hero');
    });

    it('uses the upload file name for a nested PNG card without a data name', async () => {
        const card = pngCard({
            spec: 'chara_card_v3',
            spec_version: '3.0',
            data: { description: 'unnamed v3 card' },
        });
        const res = await postImport(cardUpload(card, 'Nested Hero.png', 'image/png'));
        assert.equal(res.status, 201);
        const character = await res.json();
        assert.equal(character.name, 'Nested Hero');
        assert.equal(character.description, 'unnamed v3 card');
    });

    it('ignores privileged and config fields from the card (poisoning)', async () => {
        const card = {
            name: 'Poisoner',
            id: 'attacker-id',
            owner_id: 'bob',
            archived: true,
            avatar_url: '/etc/passwd',
            baseUrl: 'http://attacker.example',
            provider: 'evil-provider',
            pythonExecutable: '/bin/sh',
            tts_provider: 'evil-tts',
            system: 'SYSTEM OVERRIDE',
        };
        const res = await postImport(jsonUpload(card));
        assert.equal(res.status, 201);
        const character = await res.json();
        assert.equal(character.owner_id, 'alice');
        assert.equal(character.archived, false);
        assert.notEqual(character.id, 'attacker-id');
        assert.equal(character.avatar_url, undefined);
        assert.equal(character.tts_provider, '');
        for (const key of ['baseUrl', 'provider', 'pythonExecutable', 'system']) {
            assert.equal(character[key], undefined);
        }
    });

    it('ignores privileged and config fields inside nested data (poisoning)', async () => {
        const card = v3Card({
            id: 'attacker-id',
            owner_id: 'bob',
            avatar_url: '/user/images/../../etc/shadow',
            baseUrl: 'http://attacker.example',
            provider: 'evil-provider',
            pythonExecutable: '/bin/sh',
            system: 'SYSTEM OVERRIDE',
            extensions: { openparlor: { provider: 'evil', apiKey: 'secret', temperature: 0.5 } },
        });
        const res = await postImport(jsonUpload(card));
        assert.equal(res.status, 201);
        const character = await res.json();
        assert.equal(character.name, 'V3 Hero');
        assert.equal(character.owner_id, 'alice');
        assert.notEqual(character.id, 'attacker-id');
        assert.equal(character.avatar_url, undefined);
        assert.equal(character.temperature, 0.5);
        for (const key of ['baseUrl', 'provider', 'pythonExecutable', 'system', 'apiKey']) {
            assert.equal(character[key], undefined);
        }
    });

    it('rejects a card without a name', async () => {
        const res = await postImport(jsonUpload({ description: 'nameless' }));
        assert.equal(res.status, 400);
        assert.match((await res.json()).error, /name/i);
    });

    it('rejects an oversized field', async () => {
        const res = await postImport(jsonUpload({ name: 'Big', description: 'x'.repeat(20_001) }));
        assert.equal(res.status, 400);
        assert.match((await res.json()).error, /must be a string/);
    });

    it('rejects malformed JSON', async () => {
        const res = await postImport(cardUpload(Buffer.from('{"name":', 'utf8'), 'broken.json', 'application/json'));
        assert.equal(res.status, 400);
    });

    it('rejects a PNG without card metadata', async () => {
        const res = await postImport(cardUpload(PNG_1x1, 'plain.png', 'image/png'));
        assert.equal(res.status, 400);
        assert.match((await res.json()).error, /card|metadata/i);
    });

    it('rejects unsupported file contents', async () => {
        const res = await postImport(cardUpload(Buffer.from('just text', 'utf8'), 'notes.txt', 'text/plain'));
        assert.equal(res.status, 400);
    });

    it('rejects a card with a non-image avatar payload', async () => {
        const html = Buffer.from('<html>evil</html>').toString('base64');
        const card = { name: 'Evil', avatar: `data:image/png;base64,${html}` };
        const res = await postImport(jsonUpload(card));
        assert.equal(res.status, 400);
        assert.match((await res.json()).error, /avatar/i);
    });

    it('rejects an oversize card avatar', async () => {
        const card = { name: 'Huge', avatar: 'A'.repeat(MAX_CARD_AVATAR_SOURCE_LENGTH + 1) };
        const res = await postImport(jsonUpload(card));
        assert.equal(res.status, 400);
        assert.match((await res.json()).error, /too large/);
    });

    it('rejects a tts_voice that is not a known provider voice', async () => {
        const card = { name: 'Voiceless', openparlor: { tts_voice: 'not-a-voice' } };
        const res = await postImport(jsonUpload(card));
        assert.equal(res.status, 400);
        assert.match((await res.json()).error, /tts_voice/);
    });

    it('rejects imports without authentication', async () => {
        const noAuthApp = createTestApp(directories, null);
        const { server: authServer, baseUrl: authBaseUrl } = await startServer(noAuthApp);
        try {
            const res = await fetch(`${authBaseUrl}/api/openparlor/characters/import`, {
                method: 'POST',
                body: jsonUpload({ name: 'No Auth' }),
            });
            assert.equal(res.status, 401);
        } finally {
            await stopServer(authServer);
        }
    });
});

// ─── Integration: GET /:id/export and round-trip ────────────────────────────

describe('character card export (HTTP)', () => {
    let tmpRoot;
    let directories;
    let server;
    let baseUrl;

    beforeEach(async () => {
        ({ root: tmpRoot, directories } = makeRealDirs());
        const app = createTestApp(directories, { directories, profile: { handle: 'alice' } });
        ({ server, baseUrl } = await startServer(app));
    });

    afterEach(async () => {
        if (server) await stopServer(server);
        if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('exports an owned character as a v3 card with a safe attachment name', async () => {
        const created = await (await fetch(`${baseUrl}/api/openparlor/characters`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Export Me', description: 'd', first_message: 'f', temperature: 0.9, time_aware: true }),
        })).json();

        const res = await fetch(`${baseUrl}/api/openparlor/characters/${created.id}/export`);
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type') ?? '', /application\/json/);
        const disposition = res.headers.get('content-disposition') ?? '';
        assert.match(disposition, /^attachment; filename="Export_Me\.json"$/);

        const card = await res.json();
        assert.equal(card.spec, 'chara_card_v3');
        assert.equal(card.spec_version, '3.0');
        assert.equal(card.name, undefined); // character fields never leak to top level
        const data = /** @type {Record<string, unknown>} */ (card.data);
        assert.equal(data.name, 'Export Me');
        assert.equal(data.description, 'd');
        assert.equal(data.first_mes, 'f');
        assert.equal(data.extensions.openparlor.temperature, 0.9);
        assert.equal(data.extensions.openparlor.time_aware, true);
        assert.equal(new TavernCardValidator(card).validate(), 3);
    });

    it('omits the avatar when the file is missing or points outside the root', async () => {
        const created = await (await fetch(`${baseUrl}/api/openparlor/characters`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Ghost', avatar_url: '/user/images/openparlor-avatar-1.png' }),
        })).json();
        const res = await fetch(`${baseUrl}/api/openparlor/characters/${created.id}/export`);
        assert.equal(res.status, 200);
        assert.equal(/** @type {Record<string, unknown>} */ ((await res.json()).data).avatar, undefined);

        const outside = realPersistence.createCharacter(directories, 'alice', { name: 'Lurker', avatar_url: '/etc/passwd' });
        const res2 = await fetch(`${baseUrl}/api/openparlor/characters/${outside.id}/export`);
        assert.equal(res2.status, 200);
        assert.equal(/** @type {Record<string, unknown>} */ ((await res2.json()).data).avatar, undefined);
    });

    it('rejects export without authentication and for other users\' characters', async () => {
        const created = await (await fetch(`${baseUrl}/api/openparlor/characters`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Private' }),
        })).json();

        const noAuthApp = createTestApp(directories, null);
        const { server: authServer, baseUrl: authBaseUrl } = await startServer(noAuthApp);
        try {
            const res = await fetch(`${authBaseUrl}/api/openparlor/characters/${created.id}/export`);
            assert.equal(res.status, 401);
        } finally {
            await stopServer(authServer);
        }

        // A character owned by a different handle.
        const bobCharacter = realPersistence.createCharacter(directories, 'bob', { name: 'Bob\'s' });
        const res = await fetch(`${baseUrl}/api/openparlor/characters/${bobCharacter.id}/export`);
        assert.equal(res.status, 403);
    });

    it('round-trips an imported card through export and re-import', async () => {
        const original = v3Card({
            name: 'Round Trip',
            description: 'd',
            personality: 'p',
            scenario: 's',
            first_mes: 'Hi!',
            system_prompt: 'sp',
            example_dialogue: 'RT: hello',
            tags: ['one', 'two'],
            avatar: `data:image/png;base64,${PNG_1x1.toString('base64')}`,
            extensions: { openparlor: { temperature: 0.3, max_tokens: 512, time_aware: false, tts_voice: 'bf_emma' } },
        });
        const first = await (await fetch(`${baseUrl}/api/openparlor/characters/import`, {
            method: 'POST',
            body: jsonUpload(original),
        })).json();

        const exported = await (await fetch(`${baseUrl}/api/openparlor/characters/${first.id}/export`)).json();
        // The export is a standard nested Tavern Card V3, not a nonstandard
        // OpenParlor-only shape.
        assert.equal(exported.spec, 'chara_card_v3');
        assert.equal(exported.spec_version, '3.0');
        assert.equal(new TavernCardValidator(exported).validate(), 3);
        assert.equal(exported.name, undefined);
        assert.equal(exported.data.name, 'Round Trip');
        assert.ok(typeof exported.data.avatar === 'string' && exported.data.avatar.startsWith('data:image/png;base64,'));
        const avatarBytes = Buffer.from(/** @type {string} */ (exported.data.avatar).split(',', 2)[1], 'base64');
        assert.deepEqual(avatarBytes, PNG_1x1);
        assert.deepEqual(exported.data.extensions.openparlor, {
            temperature: 0.3, max_tokens: 512, time_aware: false, tts_voice: 'bf_emma',
        });

        // Re-import the exported card as a fresh character.
        const secondRes = await fetch(`${baseUrl}/api/openparlor/characters/import`, {
            method: 'POST',
            body: cardUpload(Buffer.from(JSON.stringify(exported), 'utf8'), 'round-trip.json', 'application/json'),
        });
        assert.equal(secondRes.status, 201);
        const second = await secondRes.json();
        for (const [field, value] of Object.entries({
            name: 'Round Trip',
            description: 'd',
            personality: 'p',
            scenario: 's',
            first_message: 'Hi!',
            system_prompt: 'sp',
            example_dialogue: 'RT: hello',
            temperature: 0.3,
            max_tokens: 512,
            time_aware: false,
            tts_voice: 'bf_emma',
        })) {
            assert.equal(second[field], value, `mismatch on ${field}`);
        }
        assert.deepEqual(second.tags, ['one', 'two']);
        const secondAvatar = fs.readFileSync(path.join(tmpRoot, 'user', 'images', path.basename(second.avatar_url)));
        const firstAvatar = fs.readFileSync(path.join(tmpRoot, 'user', 'images', path.basename(first.avatar_url)));
        assert.deepEqual(secondAvatar, firstAvatar);
    });
});
