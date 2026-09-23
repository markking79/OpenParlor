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
    it('builds a v3 card from a full character', () => {
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
        assert.equal(card.name, 'Alice');
        assert.equal(card.description, 'desc');
        assert.equal(card.personality, 'personality');
        assert.equal(card.scenario, 'scenario');
        assert.equal(card.first_mes, 'Hi!');
        assert.equal(card.system_prompt, 'You are Alice.');
        assert.equal(card.example_dialogue, 'Alice: Hello');
        assert.deepEqual(card.tags, ['a', 'b']);
        assert.equal(card.avatar, 'data:image/png;base64,AAA=');
        assert.deepEqual(card.openparlor, { temperature: 0.7, max_tokens: 1024, time_aware: true, tts_voice: 'af_heart' });
    });

    it('omits optional fields and the openparlor extension when not set', () => {
        const card = buildExportCard({ name: 'Minimal' });
        assert.equal(card.name, 'Minimal');
        assert.equal(card.description, '');
        assert.equal(card.personality, '');
        assert.equal(card.openparlor, undefined);
        assert.equal(card.avatar, undefined);
        // The card must round-trip through parseCardBuffer/normalizeCardCharacter.
        const parsed = parseCardBuffer(Buffer.from(JSON.stringify(card), 'utf8'));
        assert.ok('card' in parsed);
        const normalized = normalizeCardCharacter(/** @type {{ card: object }} */ (parsed).card);
        assert.ok('value' in normalized);
        assert.equal(/** @type {{ value: object }} */ (normalized).value.name, 'Minimal');
    });

    it('filters non-string tags', () => {
        const card = buildExportCard({ name: 'X', tags: ['a', 1, 'b'] });
        assert.deepEqual(card.tags, ['a', 'b']);
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

    it('imports a v3 JSON card with an avatar data URI', async () => {
        const card = {
            name: 'Imported Alice',
            description: 'from a card',
            personality: 'curious',
            scenario: 'a tavern',
            first_mes: 'Hi there!',
            system_prompt: 'You are Alice.',
            example_dialogue: 'Alice: hello',
            tags: 'friendly, witty',
            avatar: `data:image/png;base64,${PNG_1x1.toString('base64')}`,
            openparlor: { temperature: 0.7, max_tokens: 1024, time_aware: true, tts_voice: 'af_heart' },
        };
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

    it('imports a v2 PNG card with embedded metadata', async () => {
        const card = pngCard({ name: 'Png Hero', description: 'in a png', first_mes: 'yo', mes_example: 'A: hi' });
        const res = await postImport(cardUpload(card, 'hero.png', 'image/png'));
        assert.equal(res.status, 201);
        const character = await res.json();
        assert.equal(character.name, 'Png Hero');
        assert.equal(character.description, 'in a png');
        assert.equal(character.first_message, 'yo');
        assert.equal(character.example_dialogue, 'A: hi');
        // A bare PNG card (no avatar field in metadata) has no avatar.
        assert.equal(character.avatar_url, undefined);
    });

    it('stores the avatar field of a PNG card when present', async () => {
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
        assert.equal(card.name, 'Export Me');
        assert.equal(card.description, 'd');
        assert.equal(card.first_mes, 'f');
        assert.equal(card.openparlor.temperature, 0.9);
        assert.equal(card.openparlor.time_aware, true);
    });

    it('omits the avatar when the file is missing or points outside the root', async () => {
        const created = await (await fetch(`${baseUrl}/api/openparlor/characters`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Ghost', avatar_url: '/user/images/openparlor-avatar-1.png' }),
        })).json();
        const res = await fetch(`${baseUrl}/api/openparlor/characters/${created.id}/export`);
        assert.equal(res.status, 200);
        assert.equal((await res.json()).avatar, undefined);

        const outside = realPersistence.createCharacter(directories, 'alice', { name: 'Lurker', avatar_url: '/etc/passwd' });
        const res2 = await fetch(`${baseUrl}/api/openparlor/characters/${outside.id}/export`);
        assert.equal(res2.status, 200);
        assert.equal((await res2.json()).avatar, undefined);
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
        const original = {
            name: 'Round Trip',
            description: 'd',
            personality: 'p',
            scenario: 's',
            first_mes: 'Hi!',
            system_prompt: 'sp',
            example_dialogue: 'RT: hello',
            tags: ['one', 'two'],
            avatar: `data:image/png;base64,${PNG_1x1.toString('base64')}`,
            openparlor: { temperature: 0.3, max_tokens: 512, time_aware: false, tts_voice: 'bf_emma' },
        };
        const first = await (await fetch(`${baseUrl}/api/openparlor/characters/import`, {
            method: 'POST',
            body: jsonUpload(original),
        })).json();

        const exported = await (await fetch(`${baseUrl}/api/openparlor/characters/${first.id}/export`)).json();
        assert.equal(exported.name, 'Round Trip');
        assert.equal(exported.spec, 'chara_card_v3');
        assert.ok(typeof exported.avatar === 'string' && exported.avatar.startsWith('data:image/png;base64,'));
        const avatarBytes = Buffer.from(exported.avatar.split(',', 2)[1], 'base64');
        assert.deepEqual(avatarBytes, PNG_1x1);

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
