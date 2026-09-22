import express from 'express';

import * as persistence from './persistence.js';

/**
 * Creates the authenticated OpenParlor settings router.
 * @param {{ persistence?: typeof persistence }} [dependencies] Injectable dependencies for tests
 * @returns {import('express').Router} The settings router
 */
export function createOpenParlorSettingsRouter({
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

    // GET / — Load the user's OpenParlor settings
    router.get('/', (request, response) => {
        const auth = getAuthContext(request);
        if (!auth) {
            return response.status(401).json({ error: 'Authentication is required' });
        }
        const settings = persistenceModule.getSettings(auth.directories, auth.handle);
        return response.json(settings);
    });

    // PUT / — Save the user's OpenParlor settings
    router.put('/', (request, response) => {
        const auth = getAuthContext(request);
        if (!auth) {
            return response.status(401).json({ error: 'Authentication is required' });
        }
        const body = request.body ?? {};
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
            return response.status(400).json({ error: 'Settings must be a JSON object' });
        }
        const settings = persistenceModule.saveSettings(auth.directories, auth.handle, body);
        return response.json(settings);
    });

    return router;
}

export const router = createOpenParlorSettingsRouter();
