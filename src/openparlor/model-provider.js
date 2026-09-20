import { OpenAICompatibleModelProvider } from './providers/model/openai-compatible.js';

export class ModelProviderError extends Error {
    constructor(message, { status, cause } = {}) {
        super(message, { cause });
        this.name = 'ModelProviderError';
        this.status = status;
    }
}

export function createModelProvider(modelConfig, options = {}) {
    if (!modelConfig || typeof modelConfig.provider !== 'string' || !modelConfig.provider) {
        throw new ModelProviderError('Model provider is not configured');
    }
    if (modelConfig.provider !== 'openai-compatible') {
        throw new ModelProviderError(`Unsupported model provider: ${modelConfig.provider}`);
    }
    return new OpenAICompatibleModelProvider(modelConfig, options);
}
