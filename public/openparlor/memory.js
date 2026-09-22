// ─── OpenParlor memory helpers: normalization, source mapping and form validation. ─────────────────────────────────────────

export function normalizeMemory(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
        id: typeof raw.id === 'string' ? raw.id : String(raw.id || ''),
        characterId: raw.character_id != null ? String(raw.character_id) : '',
        content: typeof raw.content === 'string' ? raw.content : '',
        type: typeof raw.type === 'string' ? raw.type : 'fact',
        importance: typeof raw.importance === 'number' && Number.isFinite(raw.importance)
            ? Math.max(0, Math.min(1, raw.importance)) : 0.5,
        pinned: raw.pinned === true,
        sourceConversationId: raw.source_conversation_id != null ? String(raw.source_conversation_id) : '',
        sourceConversationTitle: typeof raw.source_conversation_title === 'string' ? raw.source_conversation_title : '',
        createdAt: typeof raw.created_at === 'string' ? raw.created_at : '',
        updatedAt: typeof raw.updated_at === 'string' ? raw.updated_at : '',
    };
}

export function normalizeMemorySource(memory, conversations) {
    if (!memory) return { label: '', available: false };
    if (!memory.sourceConversationId) return { label: 'No source', available: false };
    const conv = (conversations || []).find(c => c.id === memory.sourceConversationId);
    if (!conv) return { label: 'Source unavailable', available: false };
    return { label: conv.title || 'Untitled', available: true };
}

export function validateMemoryForm(data) {
    const errors = [];
    if (!data || typeof data !== 'object') {
        return { valid: false, errors: ['Invalid form data'] };
    }
    const content = typeof data.content === 'string' ? data.content.trim() : '';
    if (!content) {
        errors.push('Content is required');
    } else if (content.length > 2000) {
        errors.push('Content must be 2000 characters or fewer');
    }
    const type = typeof data.type === 'string' ? data.type : '';
    const allowedTypes = ['fact', 'preference', 'event', 'relationship', 'other'];
    if (!allowedTypes.includes(type)) {
        errors.push('Invalid type');
    }
    const importance = typeof data.importance === 'number' ? data.importance : NaN;
    if (isNaN(importance) || importance < 0 || importance > 1) {
        errors.push('Importance must be between 0 and 1');
    }
    return { valid: errors.length === 0, errors, content, type, importance };
}
