import express from 'express';

import * as persistence from './persistence.js';
import { getValidVoiceIds } from './tts-router.js';

const CHARACTER_FIELDS = new Set([
    'name',
    'avatar_url',
    'description',
    'personality',
    'scenario',
    'first_message',
    'system_prompt',
    'example_dialogue',
    'tags',
    'tts_voice',
    'temperature',
    'max_tokens',
    'time_aware',
]);
const MAX_TEXT_LENGTH = 20_000;

function isValidId(id) {
    return typeof id === 'string' && id.length > 0 && !id.includes('/') && !id.includes('\\') && !id.includes('..');
}

function getAuthContext(request) {
    const user = request.user;
    if (user === null || user === undefined || user.directories === null || user.directories === undefined) {
        return null;
    }
    return { directories: user.directories, handle: user.profile?.handle ?? 'unknown' };
}

function validateAvatar(value) {
    return value === '' || (value.startsWith('/') && !value.includes('\\') && !value.includes('..'));
}

/**
 * Validates a character create/update body and returns only storage-safe data.
 * @param {unknown} body
 * @param {boolean} isCreate
 * @returns {{ value: Record<string, unknown> } | { error: string }}
 */
function validateCharacterBody(body, isCreate) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return { error: 'Character data must be an object' };
    }
    const source = /** @type {Record<string, unknown>} */ (body);
    const keys = Object.keys(source);
    if (keys.some(key => !CHARACTER_FIELDS.has(key))) {
        return { error: 'Unsupported character field' };
    }
    if (isCreate && !Object.hasOwn(source, 'name')) {
        return { error: '"name" is required' };
    }
    if (!isCreate && keys.length === 0) {
        return { error: 'Provide at least one character field' };
    }

    const value = {};
    for (const key of keys) {
        const field = source[key];
        if (key === 'tags') {
            if (!Array.isArray(field) || field.length > 50 || field.some(tag => typeof tag !== 'string' || tag.trim() === '' || tag.length > 100)) {
                return { error: '"tags" must be an array of up to 50 non-empty strings' };
            }
            value.tags = field.map(tag => tag.trim());
            continue;
        }
        if (key === 'temperature') {
            if (typeof field !== 'number' || !Number.isFinite(field) || field < 0 || field > 2) {
                return { error: '"temperature" must be a number between 0 and 2' };
            }
            value.temperature = field;
            continue;
        }
        if (key === 'max_tokens') {
            if (typeof field !== 'number' || !Number.isInteger(field) || field < 1 || field > 8192) {
                return { error: '"max_tokens" must be a positive integer up to 8192' };
            }
            value.max_tokens = field;
            continue;
        }
        if (key === 'time_aware') {
            if (typeof field !== 'boolean') {
                return { error: '"time_aware" must be a boolean' };
            }
            value.time_aware = field;
            continue;
        }
        if (typeof field !== 'string' || field.length > MAX_TEXT_LENGTH) {
            return { error: `"${key}" must be a string up to ${MAX_TEXT_LENGTH} characters` };
        }
        if (key === 'name' && field.trim() === '') {
            return { error: '"name" must not be empty' };
        }
        if (key === 'avatar_url' && !validateAvatar(field)) {
            return { error: '"avatar_url" must be a browser-relative path' };
        }
        value[key] = key === 'name' ? field.trim() : field;
    }
    return { value };
}

/**
 * Creates the authenticated OpenParlor character router.
 * @param {{ persistence?: typeof persistence, ttsProvider?: { listVoices?: () => string[] | Promise<string[]> } }} [dependencies]
 * @returns {import('express').Router}
 */
export function createOpenParlorCharacterRouter({ persistence: persistenceModule = persistence, ttsProvider } = {}) {
    const router = express.Router();

    function withAuth(request, response) {
        const auth = getAuthContext(request);
        if (!auth) {
            response.status(401).json({ error: 'Authentication is required' });
            return null;
        }
        return auth;
    }

    function getOwnedCharacter(request, response, auth) {
        if (!isValidId(request.params.id)) {
            response.status(400).json({ error: 'Invalid character ID' });
            return null;
        }
        const character = persistenceModule.getCharacter(auth.directories, request.params.id);
        if (!character) {
            response.status(404).json({ error: 'Character not found' });
            return null;
        }
        if (character.owner_id !== auth.handle) {
            response.status(403).json({ error: 'Forbidden' });
            return null;
        }
        return character;
    }

    router.get('/', (request, response) => {
        const auth = withAuth(request, response);
        if (!auth) return;
        const includeArchived = request.query.include_archived === 'true';
        return response.json(persistenceModule.listCharacters(auth.directories, auth.handle, { includeArchived }));
    });

    router.post('/', async (request, response) => {
        const auth = withAuth(request, response);
        if (!auth) return;
        const validated = validateCharacterBody(request.body, true);
        if ('error' in validated) return response.status(400).json({ error: validated.error });
        const ttsVoice = validated.value.tts_voice;
        if (ttsVoice !== undefined && ttsVoice !== '') {
            const validVoices = await getValidVoiceIds(ttsProvider, auth.directories);
            if (!validVoices.has(ttsVoice)) {
                return response.status(400).json({ error: '"tts_voice" must be a valid voice ID or empty' });
            }
        }
        return response.status(201).json(persistenceModule.createCharacter(auth.directories, auth.handle, validated.value));
    });

    router.get('/:id', (request, response) => {
        const auth = withAuth(request, response);
        if (!auth) return;
        const character = getOwnedCharacter(request, response, auth);
        return character ? response.json(character) : undefined;
    });

    async function updateCharacterHandler(request, response) {
        const auth = withAuth(request, response);
        if (!auth) return;
        if (!getOwnedCharacter(request, response, auth)) return;
        const validated = validateCharacterBody(request.body, false);
        if ('error' in validated) return response.status(400).json({ error: validated.error });
        const ttsVoice = validated.value.tts_voice;
        if (ttsVoice !== undefined && ttsVoice !== '') {
            const validVoices = await getValidVoiceIds(ttsProvider, auth.directories);
            if (!validVoices.has(ttsVoice)) {
                return response.status(400).json({ error: '"tts_voice" must be a valid voice ID or empty' });
            }
        }
        return response.json(persistenceModule.updateCharacter(auth.directories, request.params.id, validated.value));
    }

    // PUT /:id and PATCH /:id share the same canonical, validated update path.
    // (PUT is preserved for backwards compatibility with the legacy monolith
    // route, which previously applied no field validation.)
    router.put('/:id', updateCharacterHandler);
    router.patch('/:id', updateCharacterHandler);

    router.delete('/:id', (request, response) => {
        const auth = withAuth(request, response);
        if (!auth) return;
        const character = getOwnedCharacter(request, response, auth);
        if (!character) return;
        // Safe deletion policy: characters still referenced by conversations
        // or memories are archived (soft delete) so history stays resolvable;
        // only unreferenced characters are hard-deleted.
        if (typeof persistenceModule.characterHasHistory === 'function'
            && persistenceModule.characterHasHistory(auth.directories, character.owner_id, character.id)) {
            const archived = persistenceModule.archiveCharacter(auth.directories, character.id);
            if (!archived) {
                return response.status(404).json({ error: 'Character not found' });
            }
            return response.json({ archived: true, deleted: false, character: archived });
        }
        if (typeof persistenceModule.removeCharacterAvatarFile === 'function') {
            persistenceModule.removeCharacterAvatarFile(auth.directories, character);
        }
        persistenceModule.deleteCharacter(auth.directories, character.id);
        return response.status(204).end();
    });

    router.post('/:id/clone', (request, response) => {
        const auth = withAuth(request, response);
        if (!auth) return;
        const character = getOwnedCharacter(request, response, auth);
        if (!character) return;
        const body = request.body;
        if (body !== null && body !== undefined && (typeof body !== 'object' || Array.isArray(body))) {
            return response.status(400).json({ error: 'Clone body must be a JSON object' });
        }
        const keys = body ? Object.keys(body) : [];
        if (keys.some(key => key !== 'name')) {
            return response.status(400).json({ error: 'Unsupported clone field' });
        }
        const requestedName = body?.name;
        if (requestedName !== undefined && (typeof requestedName !== 'string' || requestedName.trim() === '' || requestedName.length > MAX_TEXT_LENGTH)) {
            return response.status(400).json({ error: '"name" must be a non-empty string' });
        }
        const copy = Object.fromEntries(
            Object.entries(character).filter(([key]) => !['id', 'owner_id', 'created_at', 'updated_at'].includes(key)),
        );
        return response.status(201).json(persistenceModule.createCharacter(auth.directories, auth.handle, {
            ...copy,
            name: requestedName?.trim() || `Copy of ${character.name}`,
        }));
    });

    return router;
}

export const router = createOpenParlorCharacterRouter();
