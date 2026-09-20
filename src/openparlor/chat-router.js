import express from 'express';

import { loadOpenParlorConfig } from './config.js';
import { createModelProvider, ModelProviderError } from './model-provider.js';

/**
 * @typedef {Object} ChatMessage
 * @property {string} role Message role
 * @property {string} content Message content
 */

/**
 * Validates that a parsed request body contains the supported chat payload:
 * a non-empty array of objects with string "role" and "content" fields. Only
 * those two fields are ever forwarded to the model provider; unknown request
 * fields (provider, base URL, API key, model, per-message extras, ...) are
 * ignored.
 * @param {*} body Parsed request body
 * @returns {ChatMessage[] | null} Normalized messages, or null when the payload is missing or malformed
 */
function parseChatMessages(body) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return null;
    }
    const { messages } = body;
    if (!Array.isArray(messages) || messages.length === 0) {
        return null;
    }
    const normalized = [];
    for (const message of messages) {
        if (message === null || typeof message !== 'object' || Array.isArray(message)
            || typeof message.role !== 'string' || typeof message.content !== 'string') {
            return null;
        }
        normalized.push({ role: message.role, content: message.content });
    }
    return normalized;
}

/**
 * Creates the OpenParlor chat router.
 * @param {{ loadConfig?: (directories: object) => Promise<object>, createProvider?: (modelConfig: object) => { chatCompletion: (messages: ChatMessage[]) => Promise<unknown> } }} [dependencies] Injectable dependencies for tests; the production defaults use the OpenParlor configuration loader and model provider factory
 * @returns {import('express').Router} The chat router
 */
export function createOpenParlorChatRouter({
    loadConfig = loadOpenParlorConfig,
    createProvider = createModelProvider,
} = {}) {
    const router = express.Router();

    router.post('/chat', async (request, response) => {
        const messages = parseChatMessages(request.body);
        if (messages === null) {
            return response.status(400).json({ error: 'The request body must contain a non-empty "messages" array of objects with string "role" and string "content" fields' });
        }

        const user = request.user;
        if (user === null || user === undefined || user.directories === null || user.directories === undefined) {
            return response.status(401).json({ error: 'Authentication is required' });
        }

        try {
            const config = await loadConfig(user.directories);
            const provider = createProvider(config.model);
            const completion = await provider.chatCompletion(messages);
            return response.json(completion);
        } catch (error) {
            if (error instanceof ModelProviderError) {
                const status = typeof error.status === 'number' ? error.status : 503;
                return response.status(status).json({ error: error.message });
            }
            console.error('OpenParlor chat completion failed');
            return response.status(500).json({ error: 'Chat completion failed' });
        }
    });

    return router;
}

export const router = createOpenParlorChatRouter();
