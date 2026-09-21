import { createKokoroProvider, TtsProviderError } from './providers/tts/kokoro.js';

const PROVIDERS = {
    kokoro: createKokoroProvider,
};

function createTtsProvider(config) {
    if (!config || typeof config !== 'object') {
        throw new TtsProviderError('INVALID_CONFIG', 'TTS configuration is required');
    }
    const { provider, ...providerConfig } = config;
    if (!provider || typeof provider !== 'string') {
        throw new TtsProviderError('INVALID_CONFIG', 'TTS provider name is required');
    }
    const factory = PROVIDERS[provider];
    if (!factory) {
        throw new TtsProviderError('UNKNOWN_PROVIDER', `Unknown TTS provider: ${provider}`);
    }
    return factory(providerConfig);
}

export { createTtsProvider, TtsProviderError };
