import express from 'express';
import multer from 'multer';
import { loadOpenParlorConfig } from './config.js';
import { createSttProvider } from './stt-provider.js';

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const RECORDED_AUDIO_TYPES = new Set([
    'audio/webm', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/mpeg',
]);

function isAuthenticated(user) {
    return user && user.directories;
}

function safeTranscript(result) {
    if (!result || typeof result.text !== 'string') return null;
    const text = result.text.trim();
    if (!text || text.length > 100_000) return null;
    const transcript = { text };
    if (typeof result.language === 'string' && /^[a-z]{2,3}$/i.test(result.language)) {
        transcript.language = result.language.toLowerCase();
    }
    return transcript;
}

/**
 * Creates the authenticated OpenParlor speech-to-text router. Provider paths,
 * model settings, and credentials are read only from the user's server-side
 * configuration; multipart form fields never configure a provider.
 * @param {{ loadConfig?: typeof loadOpenParlorConfig, createProvider?: typeof createSttProvider }} [dependencies]
 * @returns {import('express').Router}
 */
export function createOpenParlorSttRouter({ loadConfig = loadOpenParlorConfig, createProvider = createSttProvider } = {}) {
    const router = express.Router();
    const upload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: MAX_AUDIO_BYTES, files: 1, fields: 0 },
    });

    router.post('/transcribe', (request, response, next) => {
        if (!isAuthenticated(request.user)) {
            return response.status(401).json({ error: 'Authentication is required' });
        }
        return upload.single('audio')(request, response, (error) => {
            if (error) {
                return response.status(400).json({ error: 'Invalid audio upload' });
            }
            return next();
        });
    }, async (request, response) => {
        if (!request.file || !Buffer.isBuffer(request.file.buffer) || request.file.buffer.length === 0 || request.file.buffer.length > MAX_AUDIO_BYTES) {
            return response.status(400).json({ error: 'A bounded audio upload is required' });
        }
        if (!RECORDED_AUDIO_TYPES.has(request.file.mimetype.toLowerCase())) {
            return response.status(415).json({ error: 'Unsupported audio type' });
        }

        try {
            const config = await loadConfig(request.user.directories);
            if (!config.stt.provider) {
                return response.status(503).json({ error: 'Transcription is unavailable' });
            }
            const provider = createProvider(config.stt);
            const transcript = safeTranscript(await provider.transcribe(request.file.buffer));
            if (!transcript) {
                return response.status(502).json({ error: 'Transcription failed' });
            }
            return response.json(transcript);
        } catch {
            return response.status(503).json({ error: 'Transcription is unavailable' });
        }
    });

    return router;
}

export const router = createOpenParlorSttRouter();
