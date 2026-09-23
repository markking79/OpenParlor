// ─── OpenParlor character helpers: normalization and form validation. ─────────────────────────────────────────

export function normalizeCharacter(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
        id: typeof raw.id === 'string' ? raw.id : String(raw.id || ''),
        name: typeof raw.name === 'string' ? raw.name : 'Unknown',
        avatarUrl: typeof raw.avatar_url === 'string' ? raw.avatar_url : '',
        ttsVoice: typeof raw.tts_voice === 'string' ? raw.tts_voice : '',
        archived: raw.archived === true,
    };
}

export function validateCharacterForm(data) {
    const errors = [];
    if (!data || typeof data !== 'object') {
        return { valid: false, errors: ['Invalid form data'], name: '' };
    }
    const name = typeof data.name === 'string' ? data.name.trim() : '';
    if (!name) {
        errors.push('Name is required');
    } else if (name.length > 100) {
        errors.push('Name must be 100 characters or fewer');
    }
    return { valid: errors.length === 0, errors, name };
}

export function sanitizeCharacterInput(data) {
    if (!data || typeof data !== 'object') return { name: '', avatarUrl: '', ttsVoice: '' };
    let name = typeof data.name === 'string' ? data.name.trim() : '';
    name = name.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 100);

    let avatarUrl = typeof data.avatar_url === 'string' ? data.avatar_url.trim() : '';
    if (avatarUrl) {
        const lower = avatarUrl.toLowerCase();
        if (lower.startsWith('file:') || lower.startsWith('javascript:') || lower.startsWith('data:') || avatarUrl.includes('..')) {
            avatarUrl = '';
        }
    }

    const ttsVoice = typeof data.tts_voice === 'string' ? data.tts_voice : '';

    return { name, avatarUrl, ttsVoice };
}

/**
 * Derives a safe download file name for an exported character card from the
 * server's Content-Disposition header, falling back to a sanitized character
 * name. The value is never used as a URL or path — only as an attribute of a
 * download anchor.
 * @param {string|null|undefined} contentDisposition Content-Disposition header
 * @param {string} fallbackName Character name
 * @returns {string} File name ending in .json
 */
export function buildCardExportFilename(contentDisposition, fallbackName) {
    const fallbackBase = (typeof fallbackName === 'string' ? fallbackName : '').trim();
    const fallbackSafe = fallbackBase.replace(/[^\p{L}\p{N} _-]/gu, '').trim().replace(/\s+/g, '_');
    const fallback = (fallbackSafe || 'character').slice(0, 100) + '.json';
    if (typeof contentDisposition !== 'string') return fallback;
    const match = /\bfilename="?([^";]+)"?/i.exec(contentDisposition);
    if (!match) return fallback;
    const name = match[1].trim();
    if (name === '' || name === '.' || name === '..'
        || name.includes('/') || name.includes('\\') || name.includes('\0')
        || !name.toLowerCase().endsWith('.json')) {
        return fallback;
    }
    return name;
}
