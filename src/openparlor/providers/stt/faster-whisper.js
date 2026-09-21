import { spawn } from 'node:child_process';
import path from 'node:path';

const VALID_LANGUAGES = new Set([
    'en', 'zh', 'de', 'es', 'ru', 'ko', 'fr', 'ja', 'pt', 'tr',
    'pl', 'ca', 'nl', 'ar', 'sv', 'it', 'id', 'hi', 'fi', 'vi',
    'he', 'uk', 'el', 'ms', 'cs', 'ro', 'da', 'hu', 'ta', 'no',
    'th', 'ur', 'hr', 'bg', 'lt', 'la', 'mi', 'ml', 'cy', 'sk',
    'te', 'fa', 'lv', 'bn', 'sr', 'az', 'sl', 'kn', 'et', 'mk',
    'br', 'eu', 'is', 'hy', 'ne', 'mn', 'bs', 'kk', 'sq', 'sw',
    'gl', 'mr', 'pa', 'si', 'km', 'sn', 'yo', 'so', 'af', 'oc',
    'ka', 'be', 'tg', 'sd', 'gu', 'am', 'yi', 'lo', 'uz', 'fo',
    'ht', 'ps', 'tk', 'nn', 'mt', 'sa', 'lb', 'my', 'bo', 'tl',
    'mg', 'as', 'tt', 'haw', 'ln', 'ha', 'ba', 'jw', 'su',
]);

function createFasterWhisperProvider(config, dependencies, SttProviderError) {
    const spawnFn = (dependencies && dependencies.spawn) || spawn;
    const runnerPath = path.resolve(config.runnerPath);

    function validateAudio(audio) {
        if (!Buffer.isBuffer(audio)) {
            throw new SttProviderError('INVALID_AUDIO', 'Audio must be a Buffer');
        }
        if (audio.length === 0) {
            throw new SttProviderError('INVALID_AUDIO', 'Audio must not be empty');
        }
        if (audio.length > config.maxAudioBytes) {
            throw new SttProviderError('INVALID_AUDIO', 'Audio exceeds maximum size');
        }
    }

    function validateOptions(options) {
        if (options === undefined || options === null) return {};
        if (typeof options !== 'object' || Array.isArray(options)) {
            throw new SttProviderError('INVALID_OPTIONS', 'Options must be an object');
        }
        const result = {};
        if (options.language !== undefined) {
            if (typeof options.language !== 'string' || !VALID_LANGUAGES.has(options.language)) {
                throw new SttProviderError('INVALID_OPTIONS', 'Invalid language');
            }
            result.language = options.language;
        }
        if (options.task !== undefined) {
            if (options.task !== 'transcribe' && options.task !== 'translate') {
                throw new SttProviderError('INVALID_OPTIONS', 'Invalid task');
            }
            result.task = options.task;
        }
        return result;
    }

    function buildPayload(audio, opts) {
        return JSON.stringify({
            audio_base64: audio.toString('base64'),
            model_path: config.modelPath,
            model_cache_dir: config.modelCacheDir,
            language: opts.language || config.language || null,
            task: opts.task || 'transcribe',
        });
    }

    async function transcribe(audio, options) {
        validateAudio(audio);
        const opts = validateOptions(options);

        return new Promise((resolve, reject) => {
            let child;
            try {
                child = spawnFn(config.pythonExecutable, [runnerPath], {
                    stdio: ['pipe', 'pipe', 'pipe'],
                });
            } catch {
                reject(new SttProviderError('EXECUTABLE_NOT_FOUND', 'Failed to start worker'));
                return;
            }

            let stdout = '';
            let settled = false;
            let timer;

            function settle(fn) {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                fn();
            }

            timer = setTimeout(() => {
                settle(() => reject(new SttProviderError('TIMEOUT', 'Inference timed out')));
                child.kill('SIGKILL');
            }, config.timeoutMs);

            child.stdout.on('data', (chunk) => {
                stdout += chunk.toString();
            });

            child.on('error', (err) => {
                settle(() => {
                    if (err.code === 'ENOENT') {
                        reject(new SttProviderError('EXECUTABLE_NOT_FOUND', 'Worker executable not found'));
                    } else {
                        reject(new SttProviderError('WORKER_ERROR', 'Worker process error'));
                    }
                });
            });

            child.on('close', (code) => {
                settle(() => {
                    if (code !== 0) {
                        reject(new SttProviderError('WORKER_ERROR', 'Inference failed'));
                        return;
                    }
                    try {
                        const result = JSON.parse(stdout);
                        if (typeof result.text !== 'string') {
                            reject(new SttProviderError('WORKER_ERROR', 'Malformed worker output'));
                            return;
                        }
                        const response = { text: result.text };
                        if (typeof result.language === 'string' && result.language.length > 0) {
                            response.language = result.language;
                        }
                        resolve(response);
                    } catch {
                        reject(new SttProviderError('WORKER_ERROR', 'Malformed worker output'));
                    }
                });
            });

            child.stdin.write(buildPayload(audio, opts));
            child.stdin.end();
        });
    }

    function health() {
        return new Promise((resolve, reject) => {
            let child;
            try {
                child = spawnFn(config.pythonExecutable, [runnerPath, '--health'], {
                    stdio: ['pipe', 'pipe', 'pipe'],
                });
            } catch {
                reject(new SttProviderError('EXECUTABLE_NOT_FOUND', 'Failed to start worker'));
                return;
            }

            let stdout = '';
            let settled = false;
            let timer;

            function settle(fn) {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                fn();
            }

            timer = setTimeout(() => {
                settle(() => reject(new SttProviderError('TIMEOUT', 'Health check timed out')));
                child.kill('SIGKILL');
            }, config.timeoutMs);

            child.stdout.on('data', (chunk) => {
                stdout += chunk.toString();
            });

            child.on('error', (err) => {
                settle(() => {
                    if (err.code === 'ENOENT') {
                        reject(new SttProviderError('EXECUTABLE_NOT_FOUND', 'Worker executable not found'));
                    } else {
                        reject(new SttProviderError('WORKER_ERROR', 'Worker process error'));
                    }
                });
            });

            child.on('close', (code) => {
                settle(() => {
                    if (code !== 0) {
                        reject(new SttProviderError('WORKER_ERROR', 'Health check failed'));
                        return;
                    }
                    try {
                        const result = JSON.parse(stdout);
                        if (result.status !== 'ok') {
                            reject(new SttProviderError('WORKER_ERROR', 'Health check failed'));
                            return;
                        }
                        resolve({ status: 'ok' });
                    } catch {
                        reject(new SttProviderError('WORKER_ERROR', 'Malformed health response'));
                    }
                });
            });

            child.stdin.end();
        });
    }

    return { transcribe, health };
}

export { createFasterWhisperProvider };
