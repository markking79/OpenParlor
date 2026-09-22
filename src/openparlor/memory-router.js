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
 * Creates the authenticated OpenParlor memory router.
 * @param {{ persistence?: typeof persistence }} [dependencies] Injectable dependencies for tests
 * @returns {import('express').Router} The memory router
 */
export function createOpenParlorMemoryRouter({
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
     * Loads a memory and verifies the request targets a valid, owned record.
     * @param {import('express').Request} request
     * @param {import('express').Response} response
     * @param {{ handle: string, directories: object }} auth
     * @returns {object|null} The memory, or null after a response was sent
     */
    function getOwnedMemory(request, response, auth) {
        if (!isValidId(request.params.id)) {
            response.status(400).json({ error: 'Invalid memory ID' });
            return null;
        }
        const memory = persistenceModule.getMemory(auth.directories, request.params.id);
        if (!memory) {
            response.status(404).json({ error: 'Memory not found' });
            return null;
        }
        if (memory.owner_id !== auth.handle) {
            response.status(403).json({ error: 'Forbidden' });
            return null;
        }
        return memory;
    }

    // POST / — Create a memory
    router.post('/', (request, response) => {
        const auth = getAuthContext(request);
        if (!auth) {
            return response.status(401).json({ error: 'Authentication is required' });
        }
        const memory = persistenceModule.createMemory(auth.directories, auth.handle, request.body ?? {});
        return response.status(201).json(memory);
    });

    // GET / — List the user's memories (optionally filtered by character)
    router.get('/', (request, response) => {
        const auth = getAuthContext(request);
        if (!auth) {
            return response.status(401).json({ error: 'Authentication is required' });
        }
        const { character_id } = request.query;
        const memories = persistenceModule.listMemories(auth.directories, auth.handle, character_id);
        return response.json(memories);
    });

    // GET /:id — Load a single memory
    router.get('/:id', (request, response) => {
        const auth = getAuthContext(request);
        if (!auth) {
            return response.status(401).json({ error: 'Authentication is required' });
        }
        const memory = getOwnedMemory(request, response, auth);
        return memory ? response.json(memory) : undefined;
    });

    // PUT /:id — Update a memory
    router.put('/:id', (request, response) => {
        const auth = getAuthContext(request);
        if (!auth) {
            return response.status(401).json({ error: 'Authentication is required' });
        }
        if (!getOwnedMemory(request, response, auth)) return;
        const updated = persistenceModule.updateMemory(auth.directories, request.params.id, request.body ?? {});
        return updated ? response.json(updated) : response.status(404).json({ error: 'Memory not found' });
    });

    // DELETE /:id — Delete a memory
    router.delete('/:id', (request, response) => {
        const auth = getAuthContext(request);
        if (!auth) {
            return response.status(401).json({ error: 'Authentication is required' });
        }
        if (!getOwnedMemory(request, response, auth)) return;
        persistenceModule.deleteMemory(auth.directories, request.params.id);
        return response.status(204).end();
    });

    // PUT /:id/pin — Toggle or set the pinned flag
    router.put('/:id/pin', (request, response) => {
        const auth = getAuthContext(request);
        if (!auth) {
            return response.status(401).json({ error: 'Authentication is required' });
        }
        const memory = getOwnedMemory(request, response, auth);
        if (!memory) return;
        const pinned = request.body && typeof request.body.pinned === 'boolean' ? request.body.pinned : !memory.pinned;
        const updated = persistenceModule.updateMemory(auth.directories, request.params.id, { pinned });
        return updated ? response.json(updated) : response.status(404).json({ error: 'Memory not found' });
    });

    return router;
}

export const router = createOpenParlorMemoryRouter();
