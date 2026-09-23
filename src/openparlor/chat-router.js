import express from 'express';

import { loadOpenParlorConfig } from './config.js';
import { createModelProvider, ModelProviderError } from './model-provider.js';
import * as persistence from './persistence.js';
import { buildPrompt } from './prompt-builder.js';
import { applyPromptBudget, resolvePromptBudget, resolveGenerationReserve } from './prompt-budget.js';
import { sanitizeSummaryForPrompt, updateConversationSummary } from './conversation-summary.js';
import { retrieveMemories } from './memory-retrieval.js';
import { extractAndPersistMemories } from './memory-extractor.js';
import { selectSpeakers } from './speaker-director.js';

/**
 * @typedef {Object} ChatMessage
 * @property {string} role Message role
 * @property {string} content Message content
 */

/**
 * Validates that a parsed request body contains the supported chat payload:
 * a non-empty array of objects with string "role" and "content" fields. Only
 * those two fields are ever forwarded to the model provider; unknown request
 * fields (provider, base URL, API key, model, per-message extras, ...) are
 * ignored.
 * @param {*} body Parsed request body
 * @returns {ChatMessage[] | null} Normalized messages, or null when the payload is missing or malformed
 */
function parseChatMessages(body) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return null;
    }
    const { messages } = body;
    if (!Array.isArray(messages) || messages.length === 0) {
        return null;
    }
    const normalized = [];
    for (const message of messages) {
        if (message === null || typeof message !== 'object' || Array.isArray(message)
            || typeof message.role !== 'string' || typeof message.content !== 'string') {
            return null;
        }
        normalized.push({ role: message.role, content: message.content });
    }
    return normalized;
}

/**
 * Extracts a safe delta content from one provider SSE line. Only `data:`
 * lines whose JSON payload contains a non-empty string
 * `choices[0].delta.content` produce output; the `[DONE]` marker, comments,
 * other event fields, and malformed payloads are ignored. No provider
 * configuration, secrets, or upstream data beyond that field is ever part of
 * the result.
 * @param {string} line One line of an OpenAI-compatible SSE stream
 * @returns {string | null} The delta content, or null when the line carries none
 */
function extractSseDelta(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) {
        return null;
    }
    const payload = trimmed.slice(5).trimStart();
    if (payload === '' || payload === '[DONE]') {
        return null;
    }
    let parsed;
    try {
        parsed = JSON.parse(payload);
    } catch {
        return null;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
    }
    const choices = parsed.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
        return null;
    }
    const choice = choices[0];
    if (choice === null || typeof choice !== 'object' || Array.isArray(choice)) {
        return null;
    }
    const delta = choice.delta;
    if (delta === null || typeof delta !== 'object' || Array.isArray(delta)) {
        return null;
    }
    return typeof delta.content === 'string' && delta.content !== '' ? delta.content : null;
}

/**
 * Extracts server-stored generation options from a character record.
 * Only returns an object when at least one valid option is present.
 * @param {object|null} character
 * @returns {{ temperature?: number, max_tokens?: number } | undefined}
 */
function getGenerationOptions(character) {
    if (!character) return undefined;
    const options = {};
    if (typeof character.temperature === 'number' && Number.isFinite(character.temperature)) {
        options.temperature = character.temperature;
    }
    if (typeof character.max_tokens === 'number' && Number.isFinite(character.max_tokens)) {
        options.max_tokens = character.max_tokens;
    }
    return Object.keys(options).length > 0 ? options : undefined;
}

/**
 * Creates the OpenParlor chat router.
 * @param {{ loadConfig?: (directories: object) => Promise<object>, createProvider?: (modelConfig: object) => { chatCompletion: (messages: ChatMessage[], options?: object) => Promise<unknown>, streamChatCompletion?: (messages: ChatMessage[], options?: object) => AsyncIterable<Uint8Array> } }} [dependencies] Injectable dependencies for tests; the production defaults use the OpenParlor configuration loader and model provider factory
 * @returns {import('express').Router} The chat router
 */
export function createOpenParlorChatRouter({
    loadConfig = loadOpenParlorConfig,
    createProvider = createModelProvider,
    runMemoryExtraction = extractAndPersistMemories,
} = {}) {
    const router = express.Router();

    /**
     * Schedules a fire-and-forget rolling summary refresh for a completed
     * conversation turn. The refresh runs against the provider resolved for
     * this request, is never awaited by the chat response path, and contains
     * all failures (a failed summary must never change a delivered response).
     * @param {import('../users.js').UserDirectoryList} directories
     * @param {string} conversationId
     * @param {object} provider
     */
    const scheduleSummaryRefresh = (directories, conversationId, provider) => {
        updateConversationSummary({ directories, conversation_id: conversationId, provider })
            .catch(error => {
                console.error('OpenParlor: conversation summarization failed', error);
            });
    };

    router.post('/chat', async (request, response) => {
        const messages = parseChatMessages(request.body);
        if (messages === null) {
            return response.status(400).json({ error: 'The request body must contain a non-empty "messages" array of objects with string "role" and string "content" fields' });
        }

        // Never trust browser-supplied system prompts
        const safeMessages = messages.filter(m => m.role !== 'system');

        const user = request.user;
        if (user === null || user === undefined || user.directories === null || user.directories === undefined) {
            return response.status(401).json({ error: 'Authentication is required' });
        }

        const stream = request.body.stream === true;
        const conversationId = typeof request.body.conversation_id === 'string' ? request.body.conversation_id : null;
        const handle = user.profile?.handle ?? 'unknown';

        // Validate conversation, build server-side prompt, and persist the user's message
        let speakerContexts = null;
        let participantContext = null;
        let conversation = null;
        let provider = null;
        let modelConfig = null;
        if (conversationId) {
            conversation = persistence.getConversation(user.directories, conversationId);
            if (!conversation) {
                return response.status(404).json({ error: 'Conversation not found' });
            }
            if (conversation.owner_id !== handle) {
                return response.status(403).json({ error: 'Forbidden' });
            }
            // STAB-006: ambiguous group turns may consult a model speaker
            // director, so the provider is resolved before speaker
            // selection. The standalone path below reuses it when set.
            try {
                const config = await loadConfig(user.directories);
                provider = createProvider(config.model);
                modelConfig = config.model;
            } catch (error) {
                if (error instanceof ModelProviderError) {
                    const status = typeof error.status === 'number' ? error.status : 503;
                    return response.status(status).json({ error: error.message });
                }
                console.error('OpenParlor chat completion failed');
                return response.status(500).json({ error: 'Chat completion failed' });
            }
            const characterParticipants = conversation.participants.filter(p => p.role === 'character');
            const lastUserMsg = [...safeMessages].reverse().find(m => m.role === 'user');
            const participantCharacters = characterParticipants.map(participant => persistence.getCharacter(user.directories, participant.character_id))
                .filter(Boolean);
            // Server-resolved participant context: real display names keyed by
            // participant record, so prompts can attribute speech and list
            // participants readably (stored records carry no name field).
            const characterNameById = new Map(participantCharacters.map(c => [c.id, c.name]));
            participantContext = characterParticipants
                .map(participant => ({
                    participant_id: participant.id,
                    character_id: participant.character_id,
                    name: typeof characterNameById.get(participant.character_id) === 'string'
                        ? characterNameById.get(participant.character_id)
                        : '',
                }))
                .filter(entry => entry.name !== '');
            // STAB-006: deterministic rules first; ambiguous multi-character
            // turns may consult the model speaker director, with a strict
            // decision contract and a deterministic least-recently-spoken
            // fallback when the model is unavailable or untrusted.
            const history = persistence.getMessages(user.directories, conversationId);
            const selectedSpeakers = await selectSpeakers({
                participants: characterParticipants,
                characters: participantCharacters,
                userMessage: lastUserMsg?.content ?? '',
                recentMessages: history,
                provider,
            });
            if (selectedSpeakers.length === 0) {
                return response.status(400).json({ error: 'Conversation has no character participant' });
            }

            // STAB-005: rolling summary + prompt budget. The stored summary is
            // sanitized before injection (delimiters and newlines neutralized so
            // it can only ever act as context). Every speaker's prompt is
            // bounded to the model context resolved from the server
            // configuration with the documented fallback, reserving the
            // larger of the default generation reserve and that character's
            // server-controlled max_tokens so its full generation always fits.
            const summary = sanitizeSummaryForPrompt(conversation.summary);
            speakerContexts = [];
            for (const speaker of selectedSpeakers) {
                const character = persistence.getCharacter(user.directories, speaker.character_id);
                if (!character) continue;
                const memoryLines = lastUserMsg
                    ? retrieveMemories(user.directories, handle, character.id, lastUserMsg.content)
                    : [];
                const prompt = applyPromptBudget(
                    buildPrompt({ character, conversation, history, newMessages: safeMessages, memories: memoryLines, participantContext, summary }),
                    resolvePromptBudget(modelConfig, resolveGenerationReserve(character)),
                );
                speakerContexts.push({ participant: speaker, character, prompt });
            }
            if (speakerContexts.length === 0) {
                return response.status(400).json({ error: 'Conversation has no character participant' });
            }

            if (lastUserMsg) {
                persistence.appendMessage(user.directories, conversationId, speakerContexts[0].participant.id, lastUserMsg.content, 'user');
            }
        }

        try {
            if (!provider) {
                const config = await loadConfig(user.directories);
                provider = createProvider(config.model);
                modelConfig = config.model;
            }

            if (!stream) {
                if (!speakerContexts) {
                    const completion = await provider.chatCompletion(
                        applyPromptBudget(safeMessages, resolvePromptBudget(modelConfig)),
                    );
                    response.json(completion);
                    return;
                }

                if (speakerContexts.length === 1) {
                    const { participant, character, prompt } = speakerContexts[0];
                    const genOptions = getGenerationOptions(character);
                    const completion = await provider.chatCompletion(prompt, genOptions);
                    const assistantContent = typeof completion?.choices?.[0]?.message?.content === 'string'
                        ? completion.choices[0].message.content
                        : JSON.stringify(completion);
                    const assistantMsg = persistence.appendMessage(user.directories, conversationId, participant.id, assistantContent, 'character');
                    response.json({ ...completion, conversation_id: conversationId });
                    const knownBy = conversation.participants
                        .filter(p => p.role === 'character')
                        .map(p => p.character_id)
                        .filter((id, idx, arr) => arr.indexOf(id) === idx);
                    const extractionMessages = [
                        ...safeMessages.filter(m => m.role === 'user').map(m => ({ role: 'user', content: m.content })),
                        { role: 'character', content: assistantContent },
                    ];
                    runMemoryExtraction({
                        directories: user.directories,
                        owner_id: handle,
                        character,
                        conversation,
                        messages: extractionMessages,
                        source_message_id: assistantMsg.id,
                        known_by_character_ids: knownBy,
                        participants: participantContext?.map(p => ({ name: p.name })),
                        provider,
                    }).catch(err => {
                        console.error('OpenParlor: memory extraction failed', err);
                    });
                    // STAB-005: keep the rolling summary current after a
                    // successful turn (fire-and-forget; never blocks or alters
                    // the response).
                    scheduleSummaryRefresh(user.directories, conversationId, provider);
                    return;
                }

                const responses = [];
                for (const { participant, character, prompt } of speakerContexts) {
                    try {
                        const genOptions = getGenerationOptions(character);
                        const completion = await provider.chatCompletion(prompt, genOptions);
                        const content = typeof completion?.choices?.[0]?.message?.content === 'string'
                            ? completion.choices[0].message.content
                            : JSON.stringify(completion);
                        const msg = persistence.appendMessage(user.directories, conversationId, participant.id, content, 'character');
                        responses.push({ character_id: character.id, participant_id: participant.id, content, message_id: msg.id });
                    } catch {
                        responses.push({ character_id: character.id, participant_id: participant.id, error: 'Chat completion failed' });
                    }
                }
                response.json({ conversation_id: conversationId, responses });
                const knownBy = conversation.participants
                    .filter(p => p.role === 'character')
                    .map(p => p.character_id)
                    .filter((id, idx, arr) => arr.indexOf(id) === idx);
                for (const { character } of speakerContexts) {
                    const resp = responses.find(r => r.character_id === character.id && !r.error);
                    if (!resp) continue;
                    const extractionMessages = [
                        ...safeMessages.filter(m => m.role === 'user').map(m => ({ role: 'user', content: m.content })),
                        { role: 'character', content: resp.content },
                    ];
                    runMemoryExtraction({
                        directories: user.directories,
                        owner_id: handle,
                        character,
                        conversation,
                        messages: extractionMessages,
                        source_message_id: resp.message_id,
                        known_by_character_ids: knownBy,
                        participants: participantContext?.map(p => ({ name: p.name })),
                        provider,
                    }).catch(err => {
                        console.error('OpenParlor: memory extraction failed', err);
                    });
                }
                // STAB-005: refresh the rolling summary once at least one
                // speaker produced a persisted reply for this turn.
                if (responses.some(r => !r.error)) {
                    scheduleSummaryRefresh(user.directories, conversationId, provider);
                }
                return;
            }

            response.writeHead(200, {
                'Content-Type': 'application/x-ndjson; charset=utf-8',
                'Cache-Control': 'no-cache',
                'X-Accel-Buffering': 'no',
            });

            const abortController = new AbortController();
            const abortStream = () => abortController.abort();
            request.once('aborted', abortStream);
            response.once('close', abortStream);

            const writeRecord = (record) => {
                response.write(JSON.stringify(record) + '\n');
            };

            const contexts = speakerContexts
                || [{ participant: null, character: null, prompt: applyPromptBudget(safeMessages, resolvePromptBudget(modelConfig)) }];
            const extractionResults = [];
            let hadStreamError = false;

            try {
                for (const { participant, character, prompt } of contexts) {
                    if (character) {
                        writeRecord({ type: 'speaker_start', character_id: character.id, participant_id: participant.id });
                    }

                    const decoder = new TextDecoder('utf-8', { stream: true });
                    let buffer = '';
                    let speakerText = '';
                    let speakerMessageId = null;

                    try {
                        const genOptions = getGenerationOptions(character);
                        const streamOpts = { signal: abortController.signal, ...(genOptions || {}) };
                        const result = await provider.streamChatCompletion(prompt, streamOpts);
                        for await (const chunk of result) {
                            buffer += decoder.decode(chunk, { stream: true });
                            const lines = buffer.split('\n');
                            buffer = lines.pop();
                            for (const line of lines) {
                                const delta = extractSseDelta(line);
                                if (delta !== null) {
                                    speakerText += delta;
                                    writeRecord({ type: 'delta', text: delta });
                                }
                            }
                        }
                        buffer += decoder.decode();
                        if (buffer) {
                            const delta = extractSseDelta(buffer);
                            if (delta !== null) {
                                speakerText += delta;
                                writeRecord({ type: 'delta', text: delta });
                            }
                        }
                        if (participant && speakerText) {
                            try {
                                const msg = persistence.appendMessage(user.directories, conversationId, participant.id, speakerText, 'character');
                                speakerMessageId = msg.id;
                            } catch (persistErr) {
                                console.error('OpenParlor: failed to persist assistant message', persistErr);
                            }
                        }
                        if (character) {
                            writeRecord({ type: 'speaker_end', character_id: character.id, participant_id: participant.id });
                        }
                        if (character && speakerMessageId && speakerText) {
                            extractionResults.push({ character, content: speakerText, messageId: speakerMessageId });
                        }
                    } catch (streamError) {
                        hadStreamError = true;
                        if (streamError instanceof ModelProviderError) {
                            writeRecord({ type: 'error', error: streamError.message, ...(character ? { character_id: character.id } : {}) });
                        } else {
                            writeRecord({ type: 'error', error: 'Chat completion failed', ...(character ? { character_id: character.id } : {}) });
                        }
                    }
                }
                // Preserve the established standalone stream contract: an error
                // terminates that stream without a done record. Conversation
                // streams still complete after an isolated speaker failure so
                // the browser can release its sequential group state.
                if (!hadStreamError || conversationId) {
                    writeRecord(conversationId ? { type: 'done', conversation_id: conversationId } : { type: 'done' });
                }
            } finally {
                request.off('aborted', abortStream);
                response.off('close', abortStream);
            }
            response.end();
            for (const { character, content, messageId } of extractionResults) {
                const knownBy = conversation.participants
                    .filter(p => p.role === 'character')
                    .map(p => p.character_id)
                    .filter((id, idx, arr) => arr.indexOf(id) === idx);
                const extractionMessages = [
                    ...safeMessages.filter(m => m.role === 'user').map(m => ({ role: 'user', content: m.content })),
                    { role: 'character', content },
                ];
                runMemoryExtraction({
                    directories: user.directories,
                    owner_id: handle,
                    character,
                    conversation,
                    messages: extractionMessages,
                    source_message_id: messageId,
                    known_by_character_ids: knownBy,
                    participants: participantContext?.map(p => ({ name: p.name })),
                    provider,
                }).catch(err => {
                    console.error('OpenParlor: memory extraction failed', err);
                });
            }
            // STAB-005: refresh the rolling summary after a streamed turn that
            // produced at least one persisted reply.
            if (extractionResults.length > 0) {
                scheduleSummaryRefresh(user.directories, conversationId, provider);
            }
        } catch (error) {
            if (error instanceof ModelProviderError) {
                const status = typeof error.status === 'number' ? error.status : 503;
                return response.status(status).json({ error: error.message });
            }
            console.error('OpenParlor chat completion failed');
            return response.status(500).json({ error: 'Chat completion failed' });
        }
    });

    return router;
}

export const router = createOpenParlorChatRouter();
