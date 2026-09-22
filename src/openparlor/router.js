import express from 'express';
import * as persistence from './persistence.js';

export const router = express.Router();

/**
 * Helper to get the user's directories from the request.
 * @param {import('express').Request} req
 * @returns {import('../users.js').UserDirectoryList}
 */
function dirs(req) {
    return req.user.directories;
}

/**
 * Helper to get the user's handle from the request.
 * @param {import('express').Request} req
 * @returns {string}
 */
function handle(req) {
    return req.user.profile.handle;
}

// ─── Characters ──────────────────────────────────────────────────────────────

router.post('/characters', (req, res) => {
    try {
        const character = persistence.createCharacter(dirs(req), handle(req), req.body ?? {});
        res.status(201).send(character);
    } catch (err) {
        console.error('OpenParlor: failed to create character', err);
        res.status(500).send({ error: 'Failed to create character' });
    }
});

router.get('/characters', (req, res) => {
    try {
        const characters = persistence.listCharacters(dirs(req), handle(req));
        res.send(characters);
    } catch (err) {
        console.error('OpenParlor: failed to list characters', err);
        res.status(500).send({ error: 'Failed to list characters' });
    }
});

router.get('/characters/:id', (req, res) => {
    try {
        const character = persistence.getCharacter(dirs(req), req.params.id);
        if (!character) return res.status(404).send({ error: 'Character not found' });
        if (character.owner_id !== handle(req)) return res.status(403).send({ error: 'Forbidden' });
        res.send(character);
    } catch (err) {
        console.error('OpenParlor: failed to get character', err);
        res.status(500).send({ error: 'Failed to get character' });
    }
});

router.put('/characters/:id', (req, res) => {
    try {
        const existing = persistence.getCharacter(dirs(req), req.params.id);
        if (!existing) return res.status(404).send({ error: 'Character not found' });
        if (existing.owner_id !== handle(req)) return res.status(403).send({ error: 'Forbidden' });
        const updated = persistence.updateCharacter(dirs(req), req.params.id, req.body ?? {});
        res.send(updated);
    } catch (err) {
        console.error('OpenParlor: failed to update character', err);
        res.status(500).send({ error: 'Failed to update character' });
    }
});

router.delete('/characters/:id', (req, res) => {
    try {
        const existing = persistence.getCharacter(dirs(req), req.params.id);
        if (!existing) return res.status(404).send({ error: 'Character not found' });
        if (existing.owner_id !== handle(req)) return res.status(403).send({ error: 'Forbidden' });
        persistence.deleteCharacter(dirs(req), req.params.id);
        res.sendStatus(204);
    } catch (err) {
        console.error('OpenParlor: failed to delete character', err);
        res.status(500).send({ error: 'Failed to delete character' });
    }
});

// ─── Conversations ───────────────────────────────────────────────────────────

router.post('/conversations', (req, res) => {
    try {
        const { character_id, title, participants } = req.body ?? {};
        if (!character_id) return res.status(400).send({ error: 'character_id is required' });
        const conversation = persistence.createConversation(dirs(req), handle(req), character_id, title ?? 'New Conversation', participants);
        res.status(201).send(conversation);
    } catch (err) {
        console.error('OpenParlor: failed to create conversation', err);
        res.status(500).send({ error: 'Failed to create conversation' });
    }
});

router.get('/conversations', (req, res) => {
    try {
        const conversations = persistence.listConversations(dirs(req), handle(req));
        res.send(conversations);
    } catch (err) {
        console.error('OpenParlor: failed to list conversations', err);
        res.status(500).send({ error: 'Failed to list conversations' });
    }
});

router.get('/conversations/:id', (req, res) => {
    try {
        const conversation = persistence.getConversation(dirs(req), req.params.id);
        if (!conversation) return res.status(404).send({ error: 'Conversation not found' });
        if (conversation.owner_id !== handle(req)) return res.status(403).send({ error: 'Forbidden' });
        res.send(conversation);
    } catch (err) {
        console.error('OpenParlor: failed to get conversation', err);
        res.status(500).send({ error: 'Failed to get conversation' });
    }
});

router.put('/conversations/:id', (req, res) => {
    try {
        const existing = persistence.getConversation(dirs(req), req.params.id);
        if (!existing) return res.status(404).send({ error: 'Conversation not found' });
        if (existing.owner_id !== handle(req)) return res.status(403).send({ error: 'Forbidden' });
        const updated = persistence.updateConversation(dirs(req), req.params.id, req.body ?? {});
        res.send(updated);
    } catch (err) {
        console.error('OpenParlor: failed to update conversation', err);
        res.status(500).send({ error: 'Failed to update conversation' });
    }
});

router.delete('/conversations/:id', (req, res) => {
    try {
        const existing = persistence.getConversation(dirs(req), req.params.id);
        if (!existing) return res.status(404).send({ error: 'Conversation not found' });
        if (existing.owner_id !== handle(req)) return res.status(403).send({ error: 'Forbidden' });
        persistence.deleteConversation(dirs(req), req.params.id);
        res.sendStatus(204);
    } catch (err) {
        console.error('OpenParlor: failed to delete conversation', err);
        res.status(500).send({ error: 'Failed to delete conversation' });
    }
});

// ─── Messages ────────────────────────────────────────────────────────────────

router.post('/conversations/:id/messages', (req, res) => {
    try {
        const conversation = persistence.getConversation(dirs(req), req.params.id);
        if (!conversation) return res.status(404).send({ error: 'Conversation not found' });
        if (conversation.owner_id !== handle(req)) return res.status(403).send({ error: 'Forbidden' });

        const { participant_id, content, role } = req.body ?? {};
        if (!participant_id || !content || !role) {
            return res.status(400).send({ error: 'participant_id, content, and role are required' });
        }
        const message = persistence.appendMessage(dirs(req), req.params.id, participant_id, content, role);
        res.status(201).send(message);
    } catch (err) {
        console.error('OpenParlor: failed to append message', err);
        res.status(500).send({ error: 'Failed to append message' });
    }
});

router.get('/conversations/:id/messages', (req, res) => {
    try {
        const conversation = persistence.getConversation(dirs(req), req.params.id);
        if (!conversation) return res.status(404).send({ error: 'Conversation not found' });
        if (conversation.owner_id !== handle(req)) return res.status(403).send({ error: 'Forbidden' });
        const messages = persistence.getMessages(dirs(req), req.params.id);
        res.send(messages);
    } catch (err) {
        console.error('OpenParlor: failed to get messages', err);
        res.status(500).send({ error: 'Failed to get messages' });
    }
});

// ─── Memories ────────────────────────────────────────────────────────────────

router.post('/memories', (req, res) => {
    try {
        const memory = persistence.createMemory(dirs(req), handle(req), req.body ?? {});
        res.status(201).send(memory);
    } catch (err) {
        console.error('OpenParlor: failed to create memory', err);
        res.status(500).send({ error: 'Failed to create memory' });
    }
});

router.get('/memories', (req, res) => {
    try {
        const { character_id } = req.query;
        const memories = persistence.listMemories(dirs(req), handle(req), character_id);
        res.send(memories);
    } catch (err) {
        console.error('OpenParlor: failed to list memories', err);
        res.status(500).send({ error: 'Failed to list memories' });
    }
});

router.get('/memories/:id', (req, res) => {
    try {
        const memory = persistence.getMemory(dirs(req), req.params.id);
        if (!memory) return res.status(404).send({ error: 'Memory not found' });
        if (memory.owner_id !== handle(req)) return res.status(403).send({ error: 'Forbidden' });
        res.send(memory);
    } catch (err) {
        console.error('OpenParlor: failed to get memory', err);
        res.status(500).send({ error: 'Failed to get memory' });
    }
});

router.put('/memories/:id', (req, res) => {
    try {
        const existing = persistence.getMemory(dirs(req), req.params.id);
        if (!existing) return res.status(404).send({ error: 'Memory not found' });
        if (existing.owner_id !== handle(req)) return res.status(403).send({ error: 'Forbidden' });
        const updated = persistence.updateMemory(dirs(req), req.params.id, req.body ?? {});
        res.send(updated);
    } catch (err) {
        console.error('OpenParlor: failed to update memory', err);
        res.status(500).send({ error: 'Failed to update memory' });
    }
});

router.delete('/memories/:id', (req, res) => {
    try {
        const existing = persistence.getMemory(dirs(req), req.params.id);
        if (!existing) return res.status(404).send({ error: 'Memory not found' });
        if (existing.owner_id !== handle(req)) return res.status(403).send({ error: 'Forbidden' });
        persistence.deleteMemory(dirs(req), req.params.id);
        res.sendStatus(204);
    } catch (err) {
        console.error('OpenParlor: failed to delete memory', err);
        res.status(500).send({ error: 'Failed to delete memory' });
    }
});

router.put('/memories/:id/pin', (req, res) => {
    try {
        const existing = persistence.getMemory(dirs(req), req.params.id);
        if (!existing) return res.status(404).send({ error: 'Memory not found' });
        if (existing.owner_id !== handle(req)) return res.status(403).send({ error: 'Forbidden' });
        const pinned = req.body && typeof req.body.pinned === 'boolean' ? req.body.pinned : !existing.pinned;
        const updated = persistence.updateMemory(dirs(req), req.params.id, { pinned });
        res.send(updated);
    } catch (err) {
        console.error('OpenParlor: failed to pin memory', err);
        res.status(500).send({ error: 'Failed to pin memory' });
    }
});

// ─── Settings ────────────────────────────────────────────────────────────────

router.get('/settings', (req, res) => {
    try {
        const settings = persistence.getSettings(dirs(req), handle(req));
        res.send(settings);
    } catch (err) {
        console.error('OpenParlor: failed to get settings', err);
        res.status(500).send({ error: 'Failed to get settings' });
    }
});

router.put('/settings', (req, res) => {
    try {
        const settings = persistence.saveSettings(dirs(req), handle(req), req.body ?? {});
        res.send(settings);
    } catch (err) {
        console.error('OpenParlor: failed to save settings', err);
        res.status(500).send({ error: 'Failed to save settings' });
    }
});
