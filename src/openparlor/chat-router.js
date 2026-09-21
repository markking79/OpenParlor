import express from 'express';

import { loadOpenParlorConfig } from './config.js';
import { createModelProvider, ModelProviderError } from './model-provider.js';
import * as persistence from './persistence.js';
import { buildPrompt } from './prompt-builder.js';

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
 * Creates the OpenParlor chat router.
 * @param {{ loadConfig?: (directories: object) => Promise<object>, createProvider?: (modelConfig: object) => { chatCompletion: (messages: ChatMessage[]) => Promise<unknown> } }} [dependencies] Injectable dependencies for tests; the production defaults use the OpenParlor configuration loader and model provider factory
 * @returns {import('express').Router} The chat router
 */
export function createOpenParlorChatRouter({
    loadConfig = loadOpenParlorConfig,
    createProvider = createModelProvider,
} = {}) {
    const router = express.Router();

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
        let participantId = null;
        let modelMessages = safeMessages;
        if (conversationId) {
            const conversation = persistence.getConversation(user.directories, conversationId);
            if (!conversation) {
                return response.status(404).json({ error: 'Conversation not found' });
            }
            if (conversation.owner_id !== handle) {
                return response.status(403).json({ error: 'Forbidden' });
            }
            const characterParticipant = conversation.participants.find(p => p.role === 'character');
            if (!characterParticipant) {
                return response.status(400).json({ error: 'Conversation has no character participant' });
            }
            participantId = characterParticipant.id;

            const character = persistence.getCharacter(user.directories, characterParticipant.character_id);
            if (!character) {
                return response.status(400).json({ error: 'Character not found' });
            }

            const history = persistence.getMessages(user.directories, conversationId);
            modelMessages = buildPrompt({ character, conversation, history, newMessages: safeMessages });

            const lastUserMsg = [...safeMessages].reverse().find(m => m.role === 'user');
            if (lastUserMsg) {
                persistence.appendMessage(user.directories, conversationId, participantId, lastUserMsg.content, 'user');
            }
        }

        try {
            const config = await loadConfig(user.directories);
            const provider = createProvider(config.model);

            if (!stream) {
                const completion = await provider.chatCompletion(modelMessages);
                if (conversationId && participantId) {
                    const assistantContent = typeof completion?.choices?.[0]?.message?.content === 'string'
                        ? completion.choices[0].message.content
                        : JSON.stringify(completion);
                    persistence.appendMessage(user.directories, conversationId, participantId, assistantContent, 'character');
                }
                return response.json(conversationId ? { ...completion, conversation_id: conversationId } : completion);
            }

            response.writeHead(200, {
                'Content-Type': 'application/x-ndjson; charset=utf-8',
                'Cache-Control': 'no-cache',
                'X-Accel-Buffering': 'no',
            });

            const decoder = new TextDecoder('utf-8', { stream: true });
            let buffer = '';
            let assistantText = '';
            const abortController = new AbortController();
            const abortStream = () => abortController.abort();
            request.once('aborted', abortStream);
            response.once('close', abortStream);

            const writeRecord = (record) => {
                response.write(JSON.stringify(record) + '\n');
            };

            try {
                const result = await provider.streamChatCompletion(modelMessages, { signal: abortController.signal });
                for await (const chunk of result) {
                    buffer += decoder.decode(chunk, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop();
                    for (const line of lines) {
                        const delta = extractSseDelta(line);
                        if (delta !== null) {
                            assistantText += delta;
                            writeRecord({ type: 'delta', text: delta });
                        }
                    }
                }
                buffer += decoder.decode();
                if (buffer) {
                    const delta = extractSseDelta(buffer);
                    if (delta !== null) {
                        assistantText += delta;
                        writeRecord({ type: 'delta', text: delta });
                    }
                }
                if (conversationId && participantId && assistantText) {
                    try {
                        persistence.appendMessage(user.directories, conversationId, participantId, assistantText, 'character');
                    } catch (persistErr) {
                        console.error('OpenParlor: failed to persist assistant message', persistErr);
                    }
                }
                writeRecord(conversationId ? { type: 'done', conversation_id: conversationId } : { type: 'done' });
            } catch (streamError) {
                if (streamError instanceof ModelProviderError) {
                    writeRecord({ type: 'error', error: streamError.message });
                } else {
                    writeRecord({ type: 'error', error: 'Chat completion failed' });
                }
            } finally {
                request.off('aborted', abortStream);
                response.off('close', abortStream);
            }
            response.end();
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
