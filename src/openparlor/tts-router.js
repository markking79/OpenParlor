import express from 'express';
import { loadOpenParlorConfig } from './config.js';
import { createTtsProvider } from './tts-provider.js';
import { transformForSpeech } from './speech-text.js';

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
 * Resolves a TTS provider instance capable of synthesis.
 * Uses the injected provider if it exposes a synthesize method, otherwise
 * loads from the user's on-disk config.
 * @param {{ synthesize?: (text: string, options?: object) => Promise<{ ok: boolean, data: unknown }> } | undefined} injectedProvider
 * @param {import('../users.js').UserDirectoryList} directories
 * @returns {Promise<{ synthesize: (text: string, options?: object) => Promise<{ ok: boolean, data: unknown }> } | null>}
 */
async function resolveSynthesisProvider(injectedProvider, directories) {
    if (injectedProvider && typeof injectedProvider.synthesize === 'function') {
        return injectedProvider;
    }
    const config = await loadOpenParlorConfig(directories);
    if (!config.tts.provider) return null;
    return createTtsProvider(config.tts);
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

    router.post('/synthesize', async (request, response) => {
        const user = request.user;
        if (user === null || user === undefined || user.directories === null || user.directories === undefined) {
            return response.status(401).json({ error: 'Authentication is required' });
        }

        const body = request.body;
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
            return response.status(400).json({ error: 'Invalid request body' });
        }

        const { text, voice } = body;

        if (typeof text !== 'string' || text.trim().length === 0) {
            return response.status(400).json({ error: 'Text is required' });
        }
        if (text.length > 5000) {
            return response.status(400).json({ error: 'Text is too long' });
        }
        if (typeof voice !== 'string' || voice.length === 0) {
            return response.status(400).json({ error: 'Voice is required' });
        }

        const speechText = transformForSpeech(text);
        if (speechText.length === 0) {
            return response.status(400).json({ error: 'No speakable text after cleanup' });
        }

        try {
            const validVoices = await getValidVoiceIds(ttsProvider, user.directories);
            if (validVoices.size === 0) {
                return response.status(503).json({ error: 'TTS is not available' });
            }
            if (!validVoices.has(voice)) {
                return response.status(400).json({ error: 'Invalid voice' });
            }

            const provider = await resolveSynthesisProvider(ttsProvider, user.directories);
            if (!provider) {
                return response.status(503).json({ error: 'TTS is not available' });
            }

            const result = await provider.synthesize(speechText, { voice });
            if (!result || result.ok !== true) {
                return response.status(503).json({ error: 'TTS synthesis failed' });
            }

            const data = result.data;
            if (Buffer.isBuffer(data)) {
                response.set('Content-Type', 'audio/wav');
                response.set('Content-Disposition', 'inline');
                return response.send(data);
            }

            return response.status(503).json({ error: 'TTS synthesis failed' });
        } catch {
            return response.status(503).json({ error: 'TTS synthesis failed' });
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
