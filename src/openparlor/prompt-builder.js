const MAX_HISTORY_MESSAGES = 20;

const GLOBAL_BEHAVIOR = 'You are a character in a roleplay conversation. Stay in character at all times. Respond only as your character would.';

/**
 * Builds the authoritative model prompt from server-side character and
 * conversation data. Browser-supplied system prompts and character identity
 * are never trusted.
 *
 * @param {object} params
 * @param {object} params.character - Character record with at least { name, system_prompt, scenario }
 * @param {object} params.conversation - Stored conversation record
 * @param {Array<{role: string, content: string}>} params.history - Stored messages (roles: 'user' | 'character')
 * @param {Array<{role: string, content: string}>} params.newMessages - New messages from the request (only 'user' role is used)
 * @returns {Array<{role: string, content: string}>} Assembled model messages
 */
export function buildPrompt({ character, conversation, history, newMessages }) {
    const messages = [];

    // System prompt: global behavior + server-owned character persona + scenario
    const systemParts = [GLOBAL_BEHAVIOR];
    if (character && typeof character.system_prompt === 'string' && character.system_prompt) {
        systemParts.push(character.system_prompt);
    }
    if (character && typeof character.scenario === 'string' && character.scenario) {
        systemParts.push(`Scenario: ${character.scenario}`);
    }
    messages.push({ role: 'system', content: systemParts.join('\n\n') });

    // Bounded history with role conversion (character → assistant)
    const bounded = (history || []).filter(msg => msg && (msg.role === 'user' || msg.role === 'character')).slice(-MAX_HISTORY_MESSAGES);
    for (const msg of bounded) {
        const role = msg.role === 'character' ? 'assistant' : 'user';
        messages.push({ role, content: msg.content });
    }

    // New user messages (only 'user' role; system/assistant from browser are ignored)
    for (const msg of newMessages || []) {
        if (msg.role === 'user') {
            messages.push({ role: 'user', content: msg.content });
        }
    }

    return messages;
}

export { MAX_HISTORY_MESSAGES, GLOBAL_BEHAVIOR };
