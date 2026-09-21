import express from 'express';
import { loadOpenParlorConfig } from './config.js';
import { createTtsProvider } from './tts-provider.js';

/**
 * Normalizes a provider listVoices() response to a flat array of safe voice ID strings.
 * Handles both raw string arrays (test injection) and the adapter-shaped
 * { ok: true, data: [{ id: '...' }, ...] } response from production providers.
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizeVoiceListResponse(raw) {
    if (Array.isArray(raw)) {
        return raw.filter(v => typeof v === 'string' && v.length > 0);
    }
    if (raw && typeof raw === 'object' && raw.ok === true) {
        // data is a direct array of objects with id (test injection / simplified adapter)
        if (Array.isArray(raw.data)) {
            return raw.data
                .filter(item => item && typeof item === 'object' && typeof item.id === 'string' && item.id.length > 0)
                .map(item => item.id);
        }
        // data is { voices: [{ id: '...' }] } (production Kokoro adapter shape)
        if (raw.data && typeof raw.data === 'object' && Array.isArray(raw.data.voices)) {
            return raw.data.voices
                .filter(item => item && typeof item === 'object' && typeof item.id === 'string' && item.id.length > 0)
                .map(item => item.id);
        }
    }
    return [];
}

/**
 * Resolves voice IDs from either an injected provider or the user's on-disk TTS config.
 * @param {{ listVoices?: () => string[] | Promise<string[]> } | undefined} injectedProvider
 * @param {import('../users.js').UserDirectoryList} directories
 * @returns {Promise<string[]>}
 */
async function resolveVoices(injectedProvider, directories) {
    if (injectedProvider && typeof injectedProvider.listVoices === 'function') {
        return normalizeVoiceListResponse(await injectedProvider.listVoices());
    }
    const config = await loadOpenParlorConfig(directories);
    if (!config.tts.provider) return [];
    const provider = createTtsProvider(config.tts);
    return normalizeVoiceListResponse(await provider.listVoices());
}

/**
 * Creates the authenticated OpenParlor TTS router.
 * @param {{ ttsProvider?: { listVoices?: () => string[] | Promise<string[]> } }} [dependencies]
 * @returns {import('express').Router}
 */
export function createOpenParlorTtsRouter({ ttsProvider } = {}) {
    const router = express.Router();

    router.get('/voices', async (request, response) => {
        const user = request.user;
        if (user === null || user === undefined || user.directories === null || user.directories === undefined) {
            return response.status(401).json({ error: 'Authentication is required' });
        }

        try {
            const rawVoices = await resolveVoices(ttsProvider, user.directories);
            if (!Array.isArray(rawVoices)) {
                return response.json({ voices: [], available: false });
            }
            const safeVoices = rawVoices.filter(v => typeof v === 'string' && v.length > 0);
            return response.json({ voices: safeVoices, available: safeVoices.length > 0 });
        } catch {
            return response.json({ voices: [], available: false });
        }
    });

    return router;
}

/**
 * Gets the set of valid voice IDs from the TTS provider for a given user.
 * @param {{ listVoices?: () => string[] | Promise<string[]> } | undefined} ttsProvider
 * @param {import('../users.js').UserDirectoryList} directories
 * @returns {Promise<Set<string>>}
 */
export async function getValidVoiceIds(ttsProvider, directories) {
    try {
        const rawVoices = await resolveVoices(ttsProvider, directories);
        if (!Array.isArray(rawVoices)) return new Set();
        return new Set(rawVoices.filter(v => typeof v === 'string' && v.length > 0));
    } catch {
        return new Set();
    }
}

export const router = createOpenParlorTtsRouter();
