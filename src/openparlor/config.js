import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * @typedef {Object} OpenParlorConfig
 * @property {{ provider: string, baseUrl: string, model: string, maxContextTokens: number, disableThinking: boolean }} model Model provider configuration; `maxContextTokens` is the serving deployment context window used for prompt budgeting (0 means unconfigured, falling back to the documented default budget); `disableThinking` suppresses a reasoning model's thinking phase (true by default, because OpenParlor renders only the spoken answer)
 * @property {{ provider: string, baseUrl: string, pythonExecutable: string, runnerPath: string, modelPath: string, modelCacheDir: string, maxAudioBytes: number, timeoutMs: number, language: string }} stt Speech-to-text provider configuration
 * @property {{ provider: string, baseUrl: string, voice: string }} tts Text-to-speech provider configuration
 */

/**
 * Normalized OpenParlor configuration schema. It doubles as the disabled
 * shape returned when a user has no usable configuration file. No endpoint
 * defaults or secrets are ever supplied by this module.
 * The STT execution fields are a fixed server-owned whitelist for the local
 * faster-whisper adapter. They are deliberately not browser-editable.
 * @type {Readonly<{ model: Readonly<{ provider: string, baseUrl: string, model: string, maxContextTokens: number, disableThinking: boolean }>, stt: Readonly<{ provider: string, baseUrl: string, pythonExecutable: string, runnerPath: string, modelPath: string, modelCacheDir: string, maxAudioBytes: number, timeoutMs: number, language: string }>, tts: Readonly<{ provider: string, baseUrl: string, voice: string }> }>}
 */
const OPENPARLOR_CONFIG_SCHEMA = Object.freeze({
    model: Object.freeze({ provider: 'openai-compatible', baseUrl: '', model: '', maxContextTokens: 0, disableThinking: true }),
    stt: Object.freeze({ provider: '', baseUrl: '', pythonExecutable: '', runnerPath: '', modelPath: '', modelCacheDir: '', maxAudioBytes: 0, timeoutMs: 0, language: '' }),
    tts: Object.freeze({ provider: '', baseUrl: '', voice: '' }),
});

/**
 * Builds a fresh copy of the normalized disabled configuration.
 * @returns {OpenParlorConfig} The disabled configuration shape
 */
function createDisabledConfig() {
    return {
        model: { ...OPENPARLOR_CONFIG_SCHEMA.model },
        stt: { ...OPENPARLOR_CONFIG_SCHEMA.stt },
        tts: { ...OPENPARLOR_CONFIG_SCHEMA.tts },
    };
}

/**
 * Normalizes a single configuration field.
 * @param {*} value Raw parsed value
 * @param {string|number|boolean} defaultValue Default value from the schema
 * @returns {string|number|boolean} The value when it matches the schema type, otherwise the default
 */
function normalizeField(value, defaultValue) {
    if (typeof defaultValue === 'number') {
        return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : defaultValue;
    }
    if (typeof defaultValue === 'boolean') {
        return typeof value === 'boolean' ? value : defaultValue;
    }
    return typeof value === 'string' ? value : defaultValue;
}

/**
 * Normalizes a parsed configuration value into the supported shape.
 * Unknown fields are ignored; malformed or missing values for known fields
 * fall back to their schema default (the empty string, except for
 * `model.provider`).
 * @param {*} parsed Raw parsed JSON value
 * @returns {OpenParlorConfig | null} The normalized configuration, or null when the value is not a plain object
 */
function normalizeParsedConfig(parsed) {
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
    }
    const normalized = createDisabledConfig();
    for (const section of Object.keys(OPENPARLOR_CONFIG_SCHEMA)) {
        const source = parsed[section];
        if (source === null || typeof source !== 'object' || Array.isArray(source)) {
            continue;
        }
        for (const field of Object.keys(OPENPARLOR_CONFIG_SCHEMA[section])) {
            normalized[section][field] = normalizeField(source[field], OPENPARLOR_CONFIG_SCHEMA[section][field]);
        }
    }
    return normalized;
}

/**
 * Gets the file system path of the OpenParlor configuration for a user. The
 * path is derived exclusively from the authenticated request context.
 * @param {import('../users.js').UserDirectoryList} directories Authenticated user directories
 * @returns {string} Absolute path of the configuration file
 */
export function getOpenParlorConfigPath(directories) {
    if (directories === null || typeof directories !== 'object' || typeof directories.root !== 'string' || directories.root.length === 0) {
        throw new TypeError('User directories with a non-empty string "root" path are required');
    }
    return path.join(directories.root, 'openparlor', 'config.json');
}

/**
 * Loads the OpenParlor configuration for an authenticated user from
 * `<directories.root>/openparlor/config.json`.
 * A missing, unreadable, invalid, or malformed configuration is a normal
 * state: it fails closed to the normalized disabled shape and never creates
 * files or throws.
 * @param {import('../users.js').UserDirectoryList} directories Authenticated user directories
 * @returns {Promise<OpenParlorConfig>} The normalized configuration
 * @throws {TypeError} When `directories` does not contain a non-empty string `root`
 */
export async function loadOpenParlorConfig(directories) {
    const configPath = getOpenParlorConfigPath(directories);
    let raw;
    try {
        raw = await fs.readFile(configPath, 'utf8');
    } catch {
        return createDisabledConfig();
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return createDisabledConfig();
    }
    const normalized = normalizeParsedConfig(parsed);
    return normalized === null ? createDisabledConfig() : normalized;
}
