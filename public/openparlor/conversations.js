// ─── OpenParlor conversation helpers: normalization, NDJSON stream parsing, role mapping. ─────────────────────────────────────────

export function normalizeParticipants(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter(p => p && typeof p === 'object')
        .map(p => ({
            characterId: typeof p.character_id === 'string'
                ? p.character_id
                : (typeof p.characterId === 'string' ? p.characterId : ''),
            role: typeof p.role === 'string' ? p.role : 'character',
        }))
        .filter(p => p.characterId !== '');
}

export function normalizeConversation(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
        id: typeof raw.id === 'string' ? raw.id : String(raw.id || ''),
        title: typeof raw.title === 'string' ? raw.title : 'Untitled',
        characterId: raw.character_id != null ? String(raw.character_id) : '',
        participants: normalizeParticipants(raw.participants),
        updatedAt: typeof raw.updated_at === 'string' ? raw.updated_at : '',
    };
}

export function mapChatRole(role) {
    if (role === 'character') return 'assistant';
    return role;
}

export function createNdjsonParser() {
    const decoder = new TextDecoder('utf-8', { stream: true });
    let buffer = '';
    const records = [];

    function feed(chunk) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                records.push(JSON.parse(trimmed));
            } catch {
                // skip malformed lines
            }
        }
    }

    function flush() {
        const remaining = decoder.decode();
        if (remaining) {
            buffer += remaining;
        }
        if (buffer.trim()) {
            try {
                records.push(JSON.parse(buffer.trim()));
            } catch {
                // skip
            }
        }
        buffer = '';
    }

    return { feed, flush, records };
}

/**
 * Pure stream-message state machine for group chat replies.
 *
 * Tracks the assistant message(s) being built from NDJSON stream records:
 * - A single pending message exists before any record (standalone streams
 *   that emit deltas without a speaker_start).
 * - The first speaker_start assigns the server-determined character identity
 *   to the pending message; it never creates a new message.
 * - Each subsequent speaker_start starts a new message.
 * - Deltas and error lines append to the current message.
 *
 * @returns {{
 *   handleRecord: (record: object | null) => ({type: string, isNewMessage?: boolean, message?: object} | null),
 *   getPendingMessage: () => object,
 *   getMessages: () => Array<object>
 * }}
 */
export function createStreamMessageCollector() {
    const messages = [{ role: 'assistant', content: '' }];
    let current = messages[0];
    let speakerCount = 0;

    function handleRecord(record) {
        if (!record || typeof record !== 'object') return null;
        if (record.type === 'speaker_start') {
            speakerCount++;
            const characterId = typeof record.character_id === 'string' ? record.character_id : '';
            if (speakerCount === 1) {
                if (characterId) current.character_id = characterId;
                return { type: 'speaker_start', isNewMessage: false, message: current };
            }
            current = { role: 'assistant', content: '', character_id: characterId };
            messages.push(current);
            return { type: 'speaker_start', isNewMessage: true, message: current };
        }
        if (record.type === 'delta') {
            current.content += typeof record.text === 'string' ? record.text : '';
            return { type: 'delta', message: current };
        }
        if (record.type === 'speaker_end') {
            return { type: 'speaker_end', message: current };
        }
        if (record.type === 'error') {
            const errorText = typeof record.error === 'string' && record.error ? record.error : 'Stream error';
            current.content += '\n' + errorText;
            return { type: 'error', message: current };
        }
        if (record.type === 'done') {
            return { type: 'done' };
        }
        return null;
    }

    return {
        handleRecord,
        getPendingMessage: () => current,
        getMessages: () => messages,
    };
}
