import { OpenAICompatibleModelProvider } from './providers/model/openai-compatible.js';

export class ModelProviderError extends Error {
    constructor(message, { status, cause } = {}) {
        super(message, { cause });
        this.name = 'ModelProviderError';
        this.status = status;
    }
}

/**
 * Creates a model provider from the given configuration.
 * @param {object} modelConfig Server-stored model configuration
 * @param {object} [options] Additional provider options
 * @returns {{ chatCompletion: (messages: object[], options?: object) => Promise<unknown>, streamChatCompletion?: (messages: object[], options?: object) => AsyncIterable<Uint8Array> }}
 */
export function createModelProvider(modelConfig, options = {}) {
    if (!modelConfig || typeof modelConfig.provider !== 'string' || !modelConfig.provider) {
        throw new ModelProviderError('Model provider is not configured');
    }
    if (modelConfig.provider !== 'openai-compatible') {
        throw new ModelProviderError(`Unsupported model provider: ${modelConfig.provider}`);
    }
    return new OpenAICompatibleModelProvider(modelConfig, options);
}
