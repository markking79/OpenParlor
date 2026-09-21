import { createFasterWhisperProvider } from './providers/stt/faster-whisper.js';

export class SttProviderError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'SttProviderError';
        this.code = code;
    }
}

export function createSttProvider(config, dependencies) {
    if (!config || typeof config !== 'object') {
        throw new SttProviderError('INVALID_CONFIG', 'Configuration is required');
    }
    if (config.provider !== 'faster-whisper') {
        throw new SttProviderError('INVALID_CONFIG', 'Unsupported provider');
    }
    if (!config.pythonExecutable || typeof config.pythonExecutable !== 'string') {
        throw new SttProviderError('INVALID_CONFIG', 'pythonExecutable is required');
    }
    if (!config.runnerPath || typeof config.runnerPath !== 'string') {
        throw new SttProviderError('INVALID_CONFIG', 'runnerPath is required');
    }
    if (!config.modelPath || typeof config.modelPath !== 'string') {
        throw new SttProviderError('INVALID_CONFIG', 'modelPath is required');
    }
    if (!config.modelCacheDir || typeof config.modelCacheDir !== 'string') {
        throw new SttProviderError('INVALID_CONFIG', 'modelCacheDir is required');
    }
    if (typeof config.maxAudioBytes !== 'number' || config.maxAudioBytes <= 0) {
        throw new SttProviderError('INVALID_CONFIG', 'maxAudioBytes must be a positive number');
    }
    if (typeof config.timeoutMs !== 'number' || config.timeoutMs <= 0) {
        throw new SttProviderError('INVALID_CONFIG', 'timeoutMs must be a positive number');
    }

    return createFasterWhisperProvider(config, dependencies, SttProviderError);
}
