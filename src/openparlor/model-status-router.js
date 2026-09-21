import { Router } from 'express';

import { loadOpenParlorConfig } from './config.js';
import { createModelProvider } from './model-provider.js';

/**
 * Extracts a safe display label from a URL (hostname only, no port/path/credentials).
 * @param {string} url
 * @returns {string}
 */
export function safeEndpointLabel(url) {
    if (!url || typeof url !== 'string') return '';
    try {
        const parsed = new URL(url);
        return parsed.hostname;
    } catch {
        return '';
    }
}

/**
 * Builds the safe model status response from a parsed OpenParlor config object.
 * Uses the model provider's listModels() method to discover available models.
 * Never exposes API keys or raw provider error bodies.
 * @param {object} config The user's OpenParlor configuration
 * @param {function} [createProvider] Injectable provider factory for tests
 * @returns {Promise<{provider: string, model: string, endpointLabel: string, models: string[], connected: boolean}>}
 */
export async function buildModelStatus(config, createProvider = createModelProvider) {
    const defaultStatus = { provider: '', model: '', endpointLabel: '', models: [], connected: false };
    if (!config || typeof config !== 'object') return defaultStatus;

    const modelConfig = config.model;
    if (!modelConfig || typeof modelConfig !== 'object') return defaultStatus;

    const provider = typeof modelConfig.provider === 'string' ? modelConfig.provider : '';
    const model = typeof modelConfig.model === 'string' ? modelConfig.model : '';
    const baseUrl = typeof modelConfig.baseUrl === 'string' ? modelConfig.baseUrl : '';

    const endpointLabel = safeEndpointLabel(baseUrl);

    let models = [];
    let connected = false;
    if (baseUrl) {
        try {
            const providerInstance = createProvider(modelConfig);
            const discovered = await providerInstance.listModels();
            if (Array.isArray(discovered)) {
                models = discovered.map(m => m?.id).filter(id => typeof id === 'string').slice(0, 100);
                connected = true;
            }
        } catch {
            // provider unavailable or misconfigured
        }
    }

    return { provider, model, endpointLabel, models, connected };
}

/**
 * Creates the OpenParlor model status router.
 * @param {{ loadConfig?: (directories: object) => Promise<object>, createProvider?: (modelConfig: object) => { listModels: () => Promise<Array<{id: string}>> } }} [dependencies] Injectable dependencies for tests
 * @returns {import('express').Router} The model status router
 */
export function createOpenParlorModelStatusRouter({
    loadConfig = loadOpenParlorConfig,
    createProvider = createModelProvider,
} = {}) {
    const router = Router();

    /**
     * GET /model-status
     * Returns safe model connection status for the authenticated user.
     * Never exposes API keys or raw provider error bodies.
     */
    router.get('/model-status', async (req, res) => {
        const defaultStatus = { provider: '', model: '', endpointLabel: '', models: [], connected: false };

        try {
            const user = req.user;
            if (user === null || user === undefined) {
                return res.status(401).json({ error: 'Authentication is required' });
            }

            if (user.directories === null || user.directories === undefined) {
                return res.status(401).json({ error: 'Authentication is required' });
            }

            const config = await loadConfig(user.directories);
            const status = await buildModelStatus(config, createProvider);
            res.json(status);
        } catch {
            res.json(defaultStatus);
        }
    });

    return router;
}

export const router = createOpenParlorModelStatusRouter();
