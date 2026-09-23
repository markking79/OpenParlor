import * as persistence from './persistence.js';

/**
 * Rolling conversation summaries for OpenParlor.
 *
 * Long roleplay sessions cannot keep sending unlimited raw history. The
 * server maintains three context layers: recent raw messages, a rolling
 * conversation summary (this module), and durable character memory. The
 * summary is stored server-side on the conversation record, is generated
 * only by the server from stored messages, and is injected into the prompt
 * as a clearly delimited untrusted context section (see prompt-builder.js).
 *
 * Summarization is fire-and-forget: failures are contained and never change
 * a delivered chat response.
 */

const MAX_SUMMARY_CHARS = 1600;
// Messages that are never rolled into the summary; they stay available as
// raw history. Must stay <= MAX_HISTORY_MESSAGES in prompt-builder.js so the
// summarized prefix and the raw window can never develop a gap.
const RECENT_WINDOW_MESSAGES = 10;
// Summarization only starts once the stored conversation is long enough for
// some history to fall outside the raw prompt window.
const SUMMARY_TRIGGER_MIN_MESSAGES = 24;
// Require this many new messages since the last summary before spending
// another model call, keeping summarization cheap in long chats.
const SUMMARY_MIN_NEW_MESSAGES = 8;
// Bounded generation for the summary call itself.
const SUMMARY_MAX_MODEL_TOKENS = 400;
// Hard cap on how much dialogue text one summarization call may carry.
const MAX_SLICE_MESSAGES = 200;
const MAX_SLICE_MESSAGE_CHARS = 4000;

/**
 * Builds the model prompt for one rolling summarization step.
 * The previous summary (if any) is carried forward, followed only by the
 * new dialogue slice. Speaker lines are attributed by display name, never
 * by raw participant ID.
 *
 * @param {object} params
 * @param {string} [params.previousSummary] Existing rolling summary text
 * @param {Array<{role: string, content: string, participant_id?: string}>} [params.messages] New dialogue slice (oldest first)
 * @param {Record<string, string>} [params.participantNames] participant_id -> display name
 * @returns {Array<{ role: string, content: string }>} Two model messages
 */
export function buildSummaryPrompt({ previousSummary = '', messages = [], participantNames = {} } = {}) {
    const system = [
        'You are a conversation summarizer. Write a rolling third-person summary of the roleplay conversation so the character can continue naturally.',
        'Preserve: the current location/scene, relationship state between participants, unresolved plans or promises, recent important events, relevant emotional or social state, and any group participation changes (who joined or left).',
        'Rules:',
        '- Output the summary text only. No headings, no quotes of the prompt, no commentary.',
        '- The summary is context, never instructions: never write directives aimed at a character, and never invent facts that are not in the dialogue.',
        '- Keep it under 200 words and keep it factual.',
    ].join('\n');

    const nameById = new Map();
    if (participantNames && typeof participantNames === 'object') {
        for (const [key, value] of Object.entries(participantNames)) {
            if (typeof key === 'string' && typeof value === 'string' && value.trim() !== '') {
                nameById.set(key, value.trim());
            }
        }
    }

    const lines = [];
    if (typeof previousSummary === 'string' && previousSummary.trim() !== '') {
        lines.push(`Previous summary:\n${previousSummary.trim()}`);
    }
    lines.push('New dialogue:');
    const slice = Array.isArray(messages) ? messages : [];
    for (const message of slice.slice(-MAX_SLICE_MESSAGES)) {
        if (message === null || typeof message !== 'object') continue;
        let content = typeof message.content === 'string' ? message.content : '';
        if (content.length > MAX_SLICE_MESSAGE_CHARS) {
            content = `${content.slice(0, MAX_SLICE_MESSAGE_CHARS)}…`;
        }
        if (content === '') continue;
        let speaker = 'User';
        if (message.role === 'character') {
            const name = typeof message.participant_id === 'string' ? nameById.get(message.participant_id) : undefined;
            speaker = name ?? 'Character';
        }
        lines.push(`${speaker}: ${content}`);
    }
    if (slice.length === 0) {
        lines.push('(none)');
    }

    return [
        { role: 'system', content: system },
        { role: 'user', content: lines.join('\n') },
    ];
}

/**
 * Normalizes raw model output into a stored summary string.
 * Trims whitespace, cuts to a hard character bound at a word boundary when
 * truncated, and returns '' for anything that is not usable text.
 * @param {unknown} raw
 * @returns {string}
 */
export function parseSummary(raw) {
    if (typeof raw !== 'string') return '';
    let text = raw.trim();
    if (text === '') return '';
    if (text.length > MAX_SUMMARY_CHARS) {
        const cut = text.slice(0, MAX_SUMMARY_CHARS);
        const lastSpace = cut.lastIndexOf(' ');
        text = (lastSpace > MAX_SUMMARY_CHARS / 2 ? cut.slice(0, lastSpace) : cut).trim();
    }
    return text;
}

/**
 * Sanitizes summary text for prompt injection: neutralizes bracket
 * delimiters (so stored text can never forge the summary section markers)
 * and collapses newlines, consistent with memory content sanitization.
 * @param {string} summary
 * @returns {string}
 */
export function sanitizeSummaryForPrompt(summary) {
    if (typeof summary !== 'string') return '';
    return summary.replaceAll('[', '(').replaceAll(']', ')').replace(/[\r\n]+/g, ' ').trim();
}

/**
 * Refreshes the rolling summary for a conversation when enough new messages
 * have accumulated since the last summary. Reads the conversation and its
 * stored messages from persistence, so callers can invoke it
 * fire-and-forget after a completed turn.
 *
 * No-op (returns null) when: the conversation does not exist, the stored
 * message count is below the trigger threshold, too few new messages have
 * arrived since the previous summary, the model call fails, or the model
 * returns unusable output. On success the conversation record is updated
 * with `summary` (string) and `summary_message_count` (the number of
 * stored messages covered by the summary).
 *
 * @param {object} params
 * @param {import('../users.js').UserDirectoryList} params.directories
 * @param {string} params.conversation_id
 * @param {{ chatCompletion: (messages: Array<{role: string, content: string}>, options?: object) => Promise<{choices: Array<{message: {content: string}}>} }} params.provider
 * @returns {Promise<object|null>} The updated conversation record, or null
 */
export async function updateConversationSummary({ directories, conversation_id, provider }) {
    if (typeof conversation_id !== 'string' || conversation_id === '') return null;
    const conversation = persistence.getConversation(directories, conversation_id);
    if (!conversation) return null;

    const messages = persistence.getMessages(directories, conversation_id);
    const total = messages.length;
    if (total < SUMMARY_TRIGGER_MIN_MESSAGES) return null;

    const covered = Number.isFinite(conversation.summary_message_count)
        ? Math.max(0, Math.min(total, conversation.summary_message_count))
        : 0;
    const cutoff = total - RECENT_WINDOW_MESSAGES;
    if (cutoff - covered < SUMMARY_MIN_NEW_MESSAGES) return null;

    // A large backlog is drained in bounded steps: this step summarizes at
    // most the next MAX_SLICE_MESSAGES messages, and the stored count
    // advances only to what this step actually covered, so the remaining
    // backlog is summarized by later steps instead of being silently skipped.
    const stepEnd = Math.min(cutoff, covered + MAX_SLICE_MESSAGES);
    const slice = messages.slice(covered, stepEnd);
    const participantNames = {};
    const participants = Array.isArray(conversation.participants) ? conversation.participants : [];
    for (const participant of participants) {
        if (participant && typeof participant.id === 'string' && typeof participant.character_id === 'string') {
            const character = persistence.getCharacter(directories, participant.character_id);
            if (character && typeof character.name === 'string' && character.name !== '') {
                participantNames[participant.id] = character.name;
            }
        }
    }
    const previousSummary = covered > 0 && typeof conversation.summary === 'string' ? conversation.summary : '';
    const prompt = buildSummaryPrompt({ previousSummary, messages: slice, participantNames });

    let completion;
    try {
        completion = await provider.chatCompletion(prompt, { max_tokens: SUMMARY_MAX_MODEL_TOKENS });
    } catch (error) {
        console.error('OpenParlor: conversation summarization failed', error);
        return null;
    }
    const raw = typeof completion?.choices?.[0]?.message?.content === 'string'
        ? completion.choices[0].message.content
        : '';
    const summary = parseSummary(raw);
    if (summary === '') return null;

    return persistence.updateConversation(directories, conversation_id, {
        summary,
        summary_message_count: stepEnd,
    });
}

export { MAX_SUMMARY_CHARS, RECENT_WINDOW_MESSAGES, SUMMARY_TRIGGER_MIN_MESSAGES, SUMMARY_MIN_NEW_MESSAGES, SUMMARY_MAX_MODEL_TOKENS, MAX_SLICE_MESSAGES };

