import express from 'express';

import * as persistence from './persistence.js';

/**
 * Validates that a string looks like a safe entity ID (no path traversal).
 * @param {unknown} id
 * @returns {boolean}
 */
function isValidId(id) {
    return typeof id === 'string' && id.length > 0 && !id.includes('/') && !id.includes('\\') && !id.includes('..');
}

/**
 * Creates the OpenParlor conversation router.
 * @param {{ persistence?: typeof persistence }} [dependencies] Injectable dependencies for tests
 * @returns {import('express').Router} The conversation router
 */
export function createOpenParlorConversationRouter({
    persistence: persistenceModule = persistence,
} = {}) {
    const router = express.Router();

    /**
     * Extracts the authenticated user's handle and directories from the request.
     * @param {import('express').Request} request
     * @returns {{ handle: string, directories: object } | null}
     */
    function getAuthContext(request) {
        const user = request.user;
        if (user === null || user === undefined || user.directories === null || user.directories === undefined) {
            return null;
        }
        const handle = user.profile?.handle ?? 'unknown';
        return { handle, directories: user.directories };
    }

    /**
     * Loads a conversation and verifies ownership.
     * @param {object} directories
     * @param {string} conversationId
     * @param {string} handle
     * @returns {{ conversation: object } | { error: string, status: number }}
     */
    function getOwnedConversation(directories, conversationId, handle) {
        if (!isValidId(conversationId)) {
            return { error: 'Invalid conversation ID', status: 400 };
        }
        let conversation;
        try {
            conversation = persistenceModule.getConversation(directories, conversationId);
        } catch {
            return { error: 'Invalid conversation ID', status: 400 };
        }
        if (!conversation) {
            return { error: 'Conversation not found', status: 404 };
        }
        if (conversation.owner_id !== handle) {
            return { error: 'Forbidden', status: 403 };
        }
        return { conversation };
    }

    // POST / — Create a conversation
    router.post('/', (request, response) => {
        const auth = getAuthContext(request);
        if (!auth) {
            return response.status(401).json({ error: 'Authentication is required' });
        }
        const { character_id, title } = request.body ?? {};
        if (typeof character_id !== 'string' || character_id === '') {
            return response.status(400).json({ error: '"character_id" must be a non-empty string' });
        }
        if (typeof title !== 'string' || title === '') {
            return response.status(400).json({ error: '"title" must be a non-empty string' });
        }
        if (!isValidId(character_id)) {
            return response.status(400).json({ error: 'Invalid character ID' });
        }
        let character;
        try {
            character = persistenceModule.getCharacter(auth.directories, character_id);
        } catch {
            return response.status(400).json({ error: 'Invalid character ID' });
        }
        if (!character) {
            return response.status(404).json({ error: 'Character not found' });
        }
        if (character.owner_id !== auth.handle) {
            return response.status(403).json({ error: 'Forbidden' });
        }
        const conversation = persistenceModule.createConversation(auth.directories, auth.handle, character_id, title);
        return response.status(201).json(conversation);
    });

    // GET / — List recent conversations
    router.get('/', (request, response) => {
        const auth = getAuthContext(request);
        if (!auth) {
            return response.status(401).json({ error: 'Authentication is required' });
        }
        const conversations = persistenceModule.listConversations(auth.directories, auth.handle);
        return response.json(conversations);
    });

    // GET /:id — Load a conversation with messages
    router.get('/:id', (request, response) => {
        const auth = getAuthContext(request);
        if (!auth) {
            return response.status(401).json({ error: 'Authentication is required' });
        }
        const result = getOwnedConversation(auth.directories, request.params.id, auth.handle);
        if (result.error) {
            return response.status(result.status).json({ error: result.error });
        }
        const messages = persistenceModule.getMessages(auth.directories, request.params.id);
        return response.json({ ...result.conversation, messages });
    });

    // PATCH /:id — Rename and/or archive
    router.patch('/:id', (request, response) => {
        const auth = getAuthContext(request);
        if (!auth) {
            return response.status(401).json({ error: 'Authentication is required' });
        }
        const result = getOwnedConversation(auth.directories, request.params.id, auth.handle);
        if (result.error) {
            return response.status(result.status).json({ error: result.error });
        }
        const { title, archived } = request.body ?? {};
        /** @type {Record<string, unknown>} */
        const updates = {};
        if (title !== undefined) {
            if (typeof title !== 'string' || title === '') {
                return response.status(400).json({ error: '"title" must be a non-empty string' });
            }
            updates.title = title;
        }
        if (archived !== undefined) {
            if (typeof archived !== 'boolean') {
                return response.status(400).json({ error: '"archived" must be a boolean' });
            }
            updates.archived = archived;
        }
        if (Object.keys(updates).length === 0) {
            return response.status(400).json({ error: 'Provide "title" and/or "archived" to update' });
        }
        const updated = persistenceModule.updateConversation(auth.directories, request.params.id, updates);
        if (!updated) {
            return response.status(404).json({ error: 'Conversation not found' });
        }
        return response.json(updated);
    });

    // PUT /:id/participants — Set conversation participants
    router.put('/:id/participants', (request, response) => {
        const auth = getAuthContext(request);
        if (!auth) {
            return response.status(401).json({ error: 'Authentication is required' });
        }
        const result = getOwnedConversation(auth.directories, request.params.id, auth.handle);
        if (result.error) {
            return response.status(result.status).json({ error: result.error });
        }
        const { character_ids } = request.body ?? {};
        if (!Array.isArray(character_ids) || character_ids.length === 0) {
            return response.status(400).json({ error: '"character_ids" must be a non-empty array' });
        }
        if (character_ids.length > 10) {
            return response.status(400).json({ error: 'Maximum 10 participants allowed' });
        }
        for (const cid of character_ids) {
            if (typeof cid !== 'string' || cid === '') {
                return response.status(400).json({ error: 'Each character_id must be a non-empty string' });
            }
            if (!isValidId(cid)) {
                return response.status(400).json({ error: 'Invalid character ID' });
            }
        }
        const uniqueIds = new Set(character_ids);
        if (uniqueIds.size !== character_ids.length) {
            return response.status(400).json({ error: 'Duplicate character IDs not allowed' });
        }
        const existingByCharacterId = new Map(
            (result.conversation.participants ?? []).map(participant => [participant.character_id, participant]),
        );
        const participants = [];
        for (const cid of character_ids) {
            let character;
            try {
                character = persistenceModule.getCharacter(auth.directories, cid);
            } catch {
                return response.status(400).json({ error: 'Invalid character ID' });
            }
            if (!character) {
                return response.status(404).json({ error: 'Character not found' });
            }
            if (character.owner_id !== auth.handle) {
                return response.status(403).json({ error: 'Forbidden' });
            }
            const existingParticipant = existingByCharacterId.get(cid);
            participants.push(existingParticipant ?? {
                id: crypto.randomUUID(),
                conversation_id: result.conversation.id,
                character_id: cid,
                role: 'character',
                joined_at: new Date().toISOString(),
            });
        }
        const updated = persistenceModule.updateConversation(auth.directories, request.params.id, {
            participants,
            character_id: character_ids[0],
        });
        if (!updated) {
            return response.status(404).json({ error: 'Conversation not found' });
        }
        return response.json(updated);
    });

    // DELETE /:id — Delete a conversation
    router.delete('/:id', (request, response) => {
        const auth = getAuthContext(request);
        if (!auth) {
            return response.status(401).json({ error: 'Authentication is required' });
        }
        const result = getOwnedConversation(auth.directories, request.params.id, auth.handle);
        if (result.error) {
            return response.status(result.status).json({ error: result.error });
        }
        persistenceModule.deleteConversation(auth.directories, request.params.id);
        return response.status(204).end();
    });

    return router;
}

export const router = createOpenParlorConversationRouter();
