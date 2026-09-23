// ─── OpenParlor browser application ─────────────────────────────────────────────
// Split from openparlor.js in STAB-007. Runs only in a browser context; the
// entry module (openparlor.js) imports it for its side effects.

import { formatRelativeTime, normalizeServiceError } from './ui.js';

export function validateConversationTitle(title) {
    if (typeof title !== 'string') return { valid: false, title: '', error: 'Title is required.' };
    const trimmed = title.trim();
    if (!trimmed) return { valid: false, title: '', error: 'Title cannot be empty.' };
    if (trimmed.length > 200) return { valid: false, title: '', error: 'Title must be 200 characters or fewer.' };
    return { valid: true, title: trimmed, error: '' };
}

export function createScrollScheduler(rafFn) {
    let scheduled = false;
    let callback = null;
    return {
        schedule(fn) {
            callback = fn;
            if (!scheduled) {
                scheduled = true;
                rafFn(() => {
                    scheduled = false;
                    const cb = callback;
                    callback = null;
                    if (cb) cb();
                });
            }
        },
    };
}

export function normalizeSidebarCollapsed(value) {
    return value === true || value === 'true';
}

export function createSidebarState(storage, keys) {
    function get(side) {
        try {
            return normalizeSidebarCollapsed(storage.getItem(keys[side]));
        } catch {
            return false;
        }
    }
    function set(side, collapsed) {
        try {
            storage.setItem(keys[side], collapsed ? 'true' : 'false');
        } catch {
            // storage unavailable
        }
    }
    return { get, set };
}

export function shouldShowMemorySection({ hasConversation, hasCharacter, memoryCount }) {
    return hasConversation && hasCharacter && memoryCount > 0;
}

export function createMemoryRefreshGuard() {
    // Generation 0 is the "no refresh in flight" sentinel: begin() issues
    // 1-based generations, and isCurrent must never accept the sentinel.
    let generation = 0;
    return {
        begin() {
            return ++generation;
        },
        isCurrent(gen) {
            return gen > 0 && gen === generation;
        },
    };
}

import { createNdjsonParser, createStreamMessageCollector, normalizeConversation, resolveMessageCharacterId } from './conversations.js';
import { buildCardExportFilename, normalizeCharacter, sanitizeCharacterInput, validateCharacterForm } from './characters.js';
import { normalizeMemory, normalizeMemorySource, validateMemoryForm } from './memory.js';
import { createFirstTokenEstimator, estimateResponseStartProgress, formatResponseStartProgress } from './progress.js';
import { fetchDeferredPrerequisite, normalizeHealthStatus, normalizeModelStatus } from './settings.js';
import {
    createGroupPlaybackQueue,
    createPlaybackController,
    createRecorderController,
    createTranscriptionController,
    createVoiceTurnTimer,
    normalizeAutoSpeakState,
    normalizeTtsVoices,
    normalizeVoiceModeState,
    shouldAutoSendTranscription,
    shouldAutoSpeak,
} from './audio.js';
// ─── Browser application ─────────────────────────────────────────────────────

if (typeof document !== 'undefined') {
    const conversationList = document.getElementById('conversationList');
    const characterList = document.getElementById('characterList');
    const characterSelect = document.getElementById('characterSelect');
    const newChatButton = document.getElementById('newChatButton');
    const messagesEl = document.getElementById('messages');
    const chatTitle = document.getElementById('chatTitle');
    const chatSubtitle = document.getElementById('chatSubtitle');
    const messageInput = document.getElementById('messageInput');
    const sendButton = document.getElementById('sendButton');
    const characterForm = document.getElementById('characterForm');
    const charNameInput = document.getElementById('charNameInput');
    const charAvatarInput = document.getElementById('charAvatarInput');
    const charAvatarFileInput = document.getElementById('charAvatarFileInput');
    const charFormError = document.getElementById('charFormError');
    const charFormSave = document.getElementById('charFormSave');
    const charFormCancel = document.getElementById('charFormCancel');
    const charVoiceSelect = document.getElementById('charVoiceSelect');
    const newCharacterButton = document.getElementById('newCharacterButton');
    const importCharacterButton = document.getElementById('importCharacterButton');
    const importCharacterFileInput = document.getElementById('importCharacterFileInput');
    const charExportButton = document.getElementById('charExportButton');
    const modelStatusDot = document.getElementById('modelStatusDot');
    const modelStatusBody = document.getElementById('modelStatusBody');
    const autoSpeakButton = document.getElementById('autoSpeakButton');
    const voiceModeButton = document.getElementById('voiceModeButton');

    // ── Sidebar collapse/restore ──────────────────────────────────────────

    const appEl = document.querySelector('.app');
    const sidebarLeft = document.getElementById('sidebarLeft');
    const sidebarRight = document.getElementById('sidebarRight');
    const collapseLeftBtn = document.getElementById('collapseLeftBtn');
    const collapseRightBtn = document.getElementById('collapseRightBtn');
    const restoreLeftBtn = document.getElementById('restoreLeftBtn');
    const restoreRightBtn = document.getElementById('restoreRightBtn');

    const sidebarState = createSidebarState(localStorage, {
        left: 'openparlor-sidebar-left-collapsed',
        right: 'openparlor-sidebar-right-collapsed',
    });

    function applySidebarState(side, collapsed) {
        const sidebar = side === 'left' ? sidebarLeft : sidebarRight;
        const appClass = side === 'left' ? 'left-collapsed' : 'right-collapsed';
        const collapseBtn = side === 'left' ? collapseLeftBtn : collapseRightBtn;
        const restoreBtn = side === 'left' ? restoreLeftBtn : restoreRightBtn;
        if (sidebar) sidebar.classList.toggle('collapsed', collapsed);
        if (appEl) appEl.classList.toggle(appClass, collapsed);
        if (collapseBtn) collapseBtn.setAttribute('aria-expanded', String(!collapsed));
        if (restoreBtn) restoreBtn.setAttribute('aria-expanded', String(collapsed));
    }

    function toggleSidebar(side) {
        const appClass = side === 'left' ? 'left-collapsed' : 'right-collapsed';
        const collapsed = !(appEl && appEl.classList.contains(appClass));
        sidebarState.set(side, collapsed);
        applySidebarState(side, collapsed);
    }

    // Restore persisted state
    applySidebarState('left', sidebarState.get('left'));
    applySidebarState('right', sidebarState.get('right'));

    if (collapseLeftBtn) collapseLeftBtn.addEventListener('click', () => toggleSidebar('left'));
    if (collapseRightBtn) collapseRightBtn.addEventListener('click', () => toggleSidebar('right'));
    if (restoreLeftBtn) restoreLeftBtn.addEventListener('click', () => toggleSidebar('left'));
    if (restoreRightBtn) restoreRightBtn.addEventListener('click', () => toggleSidebar('right'));

    let characters = [];
    let allCharacters = [];
    let conversations = [];
    let currentConversation = null;
    let currentMessages = [];
    let isSending = false;
    let editingCharacterId = null;
    let ttsVoices = { voices: [], available: false };
    const playback = createPlaybackController({ getCsrfToken });
    let ttsMarkedForTurn = false;
    const groupQueue = createGroupPlaybackQueue({
        playItem: (text, voice) => {
            return new Promise((resolve, reject) => {
                let settled = false;
                const onEnd = () => {
                    if (!settled) { settled = true; resolve(); }
                };
                playback.onEnded = onEnd;
                playback.play(text, voice).then(() => {
                    if (!ttsMarkedForTurn) {
                        ttsMarkedForTurn = true;
                        voiceTurnTimer.markTtsReady();
                    }
                }).catch((e) => {
                    if (!settled) { settled = true; reject(e); }
                });
            });
        },
        onAllDone: () => {
            if (isDev) voiceTurnTimer.log();
            voiceTurnTimer.cancel();
        },
    });
    let selectionEpoch = 0;
    let recordingInterruptionPending = false;
    let streamAbortController = null;
    const isDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    const voiceTurnTimer = createVoiceTurnTimer();

    // Estimated response-start progress (DOGFOOD-007). pendingStart tracks
    // the speaker currently awaiting its first visible token; the window is
    // per-speaker so sequential group replies never share or morph state.
    const firstTokenEstimator = createFirstTokenEstimator();
    let pendingStart = null;
    let progressTimerId = null;

    // ── Auto-speak state ───────────────────────────────────────────────────

    function getAutoSpeakState(conversationId) {
        if (!conversationId) return false;
        try {
            return normalizeAutoSpeakState(localStorage.getItem('openparlor-auto-speak-' + conversationId));
        } catch {
            return false;
        }
    }

    function setAutoSpeakState(conversationId, enabled) {
        if (!conversationId) return;
        try {
            localStorage.setItem('openparlor-auto-speak-' + conversationId, enabled ? 'true' : 'false');
        } catch {
            // storage unavailable
        }
    }

    function updateAutoSpeakButton() {
        if (!autoSpeakButton) return;
        if (!currentConversation) {
            autoSpeakButton.hidden = true;
            return;
        }
        autoSpeakButton.hidden = false;
        const enabled = getAutoSpeakState(currentConversation.id);
        autoSpeakButton.setAttribute('aria-pressed', String(enabled));
        autoSpeakButton.textContent = enabled ? 'Auto-speak: On' : 'Auto-speak: Off';
    }

    // ── Voice mode state ───────────────────────────────────────────────────

    function getVoiceModeState(conversationId) {
        if (!conversationId) return false;
        try {
            return normalizeVoiceModeState(localStorage.getItem('openparlor-voice-mode-' + conversationId));
        } catch {
            return false;
        }
    }

    function setVoiceModeState(conversationId, enabled) {
        if (!conversationId) return;
        try {
            localStorage.setItem('openparlor-voice-mode-' + conversationId, enabled ? 'true' : 'false');
        } catch {
            // storage unavailable
        }
    }

    function updateVoiceModeButton() {
        if (!voiceModeButton) return;
        if (!currentConversation) {
            voiceModeButton.hidden = true;
            return;
        }
        voiceModeButton.hidden = false;
        const enabled = getVoiceModeState(currentConversation.id);
        voiceModeButton.setAttribute('aria-pressed', String(enabled));
        voiceModeButton.textContent = enabled ? 'Voice: On' : 'Voice: Off';
    }

    // ── Rendering helpers ──────────────────────────────────────────────────

    function renderState(container, type, text) {
        container.innerHTML = '';
        const el = document.createElement('div');
        el.className = 'state-' + type;
        el.textContent = text;
        container.appendChild(el);
    }

    function renderConversations() {
        conversationList.innerHTML = '';

        if (conversations.length === 0) {
            renderState(conversationList, 'empty', 'No conversations yet.');
            return;
        }

        for (const conv of conversations) {
            const char = findCharacter(conv.characterId);
            const item = document.createElement('div');
            item.className = 'conversation' + (currentConversation && currentConversation.id === conv.id ? ' active' : '');
            item.dataset.id = conv.id;

            const titleEl = document.createElement('div');
            titleEl.className = 'conversation-title';
            titleEl.textContent = conv.title;

            const metaEl = document.createElement('div');
            metaEl.className = 'conversation-preview';
            const parts = [];
            if (char) parts.push(char.name);
            const time = formatRelativeTime(conv.updatedAt);
            if (time) parts.push(time);
            metaEl.textContent = parts.join(' · ');

            const actionsEl = document.createElement('div');
            actionsEl.className = 'conversation-actions';

            const renameBtn = document.createElement('button');
            renameBtn.className = 'conversation-rename-btn';
            renameBtn.type = 'button';
            renameBtn.title = 'Rename conversation';
            renameBtn.setAttribute('aria-label', 'Rename ' + conv.title);
            renameBtn.textContent = '✎';
            renameBtn.addEventListener('click', e => {
                e.stopPropagation();
                handleRenameConversation(conv, item);
            });

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'conversation-delete-btn';
            deleteBtn.type = 'button';
            deleteBtn.title = 'Delete conversation';
            deleteBtn.setAttribute('aria-label', 'Delete ' + conv.title);
            deleteBtn.textContent = '✕';
            deleteBtn.addEventListener('click', e => {
                e.stopPropagation();
                handleDeleteConversation(conv);
            });

            actionsEl.append(renameBtn, deleteBtn);
            item.append(titleEl, metaEl, actionsEl);
            item.addEventListener('click', () => selectConversation(conv.id));
            conversationList.appendChild(item);
        }
    }

    function renderCharacters() {
        const selectedCharacterId = characterSelect.value;
        characterList.innerHTML = '';
        characterSelect.innerHTML = '<option value="">Select a character…</option>';

        if (allCharacters.length === 0) {
            renderState(characterList, 'empty', 'No characters found.');
            newChatButton.disabled = true;
            characterSelect.disabled = true;
            return;
        }

        for (const char of allCharacters) {
            // Sidebar card (archived characters remain visible to their owner
            // but are dimmed and badged)
            const card = document.createElement('div');
            card.className = 'character-card' + (char.archived ? ' archived' : '');
            card.dataset.id = char.id;

            const avatar = document.createElement('div');
            avatar.className = 'avatar';
            if (char.avatarUrl) {
                const img = document.createElement('img');
                img.src = char.avatarUrl;
                img.alt = char.name;
                img.className = 'avatar-img';
                avatar.appendChild(img);
            } else {
                avatar.textContent = char.name.charAt(0).toUpperCase();
            }

            const info = document.createElement('div');
            info.className = 'character-info';
            const nameEl = document.createElement('div');
            nameEl.className = 'character-name';
            nameEl.textContent = char.name;
            info.appendChild(nameEl);

            if (char.archived) {
                const badge = document.createElement('span');
                badge.className = 'character-archived-badge';
                badge.textContent = 'Archived';
                info.appendChild(badge);
            }

            card.append(avatar, info);
            card.addEventListener('click', () => showCharacterForm(char));

            const deleteButton = document.createElement('button');
            deleteButton.className = 'character-delete-btn';
            deleteButton.type = 'button';
            deleteButton.title = char.archived ? 'Delete archived character' : 'Delete character';
            deleteButton.setAttribute('aria-label', `${char.archived ? 'Delete archived character ' : 'Delete '}${char.name}`);
            deleteButton.textContent = '✕';
            deleteButton.addEventListener('click', event => {
                event.stopPropagation();
                handleDeleteCharacter(char);
            });
            card.appendChild(deleteButton);
            characterList.appendChild(card);

            // Select option — active characters only (normal new-chat selection)
            if (!char.archived) {
                const opt = document.createElement('option');
                opt.value = char.id;
                opt.textContent = char.name;
                characterSelect.appendChild(opt);
            }
        }

        // Make the primary action usable immediately when characters exist.
        // Preserve an explicit selection when re-rendering after edits.
        if (characters.length === 0) {
            // Only archived characters exist: nothing is selectable for a new chat.
            characterSelect.value = '';
            characterSelect.disabled = true;
            newChatButton.disabled = true;
            return;
        }
        characterSelect.value = characters.some(char => char.id === selectedCharacterId)
            ? selectedCharacterId
            : characters[0].id;
        characterSelect.disabled = false;
        newChatButton.disabled = false;
    }

    function showCharacterForm(character) {
        editingCharacterId = character ? character.id : null;
        charNameInput.value = character ? character.name : '';
        charAvatarInput.value = character ? character.avatarUrl : '';
        charAvatarFileInput.value = '';
        populateVoiceSelect(character ? character.ttsVoice : '');
        charFormError.hidden = true;
        charFormError.textContent = '';
        charExportButton.hidden = !character;
        characterForm.hidden = false;
        charNameInput.focus();
    }

    function populateVoiceSelect(selectedVoice) {
        charVoiceSelect.innerHTML = '<option value="">No voice</option>';
        for (const voice of ttsVoices.voices) {
            const opt = document.createElement('option');
            opt.value = voice;
            opt.textContent = voice;
            charVoiceSelect.appendChild(opt);
        }
        charVoiceSelect.value = selectedVoice || '';
    }

    function hideCharacterForm() {
        editingCharacterId = null;
        characterForm.hidden = true;
        charNameInput.value = '';
        charAvatarInput.value = '';
        charAvatarFileInput.value = '';
        charVoiceSelect.value = '';
        charFormError.hidden = true;
        charFormError.textContent = '';
        charExportButton.hidden = true;
    }

    function showFormError(message) {
        charFormError.textContent = message;
        charFormError.hidden = false;
    }

    function renderMessages() {
        messagesEl.innerHTML = '';

        if (!currentConversation) {
            renderState(messagesEl, 'empty', 'No conversation selected.');
            return;
        }

        if (currentMessages.length === 0) {
            renderState(messagesEl, 'empty', 'No messages yet. Say hello!');
            return;
        }

        for (const msg of currentMessages) {
            const isUser = msg.role === 'user';
            const messageEl = document.createElement('div');
            messageEl.className = 'message' + (isUser ? ' user-message' : '');

            // Neutral pending response: before speaker_start the stream
            // placeholder has no identity; do not attribute it to the
            // primary character.
            const hasIdentity = !isUser && (
                (typeof msg.character_id === 'string' && msg.character_id) ||
                (typeof msg.participant_id === 'string' && msg.participant_id)
            );
            if (!isUser && !hasIdentity) {
                const pendingContent = document.createElement('div');
                pendingContent.className = 'message-content';
                const pendingSpeaker = document.createElement('div');
                pendingSpeaker.className = 'speaker';
                pendingSpeaker.textContent = 'Preparing response…';
                const pendingBubble = document.createElement('div');
                pendingBubble.className = 'bubble';
                pendingBubble.textContent = msg.content || 'Preparing response…';
                pendingContent.append(pendingSpeaker, pendingBubble);
                messageEl.appendChild(pendingContent);
                messagesEl.appendChild(messageEl);
                continue;
            }

            const msgCharId = !isUser ? resolveMessageCharacterId(msg, currentConversation) : currentConversation.characterId;
            const char = findCharacter(msgCharId);
            const charName = char ? char.name : 'Assistant';

            if (!isUser) {
                const avatar = document.createElement('div');
                avatar.className = 'avatar';
                if (char && char.avatarUrl) {
                    const img = document.createElement('img');
                    img.src = char.avatarUrl;
                    img.alt = charName;
                    img.className = 'avatar-img';
                    avatar.appendChild(img);
                } else {
                    avatar.textContent = charName.charAt(0).toUpperCase();
                }
                messageEl.appendChild(avatar);
            }

            const content = document.createElement('div');
            content.className = 'message-content';

            const speakerEl = document.createElement('div');
            speakerEl.className = 'speaker';
            // Estimated time-to-first-token for the speaker currently
            // awaiting its first visible token (DOGFOOD-007).
            if (!isUser && !msg.content && pendingStart && pendingStart.msg === msg) {
                speakerEl.className = 'speaker speaker-progress';
                speakerEl.textContent = formatResponseStartProgress(
                    charName,
                    estimateResponseStartProgress({
                        elapsedMs: performance.now() - pendingStart.startedAt,
                        expectedMs: firstTokenEstimator.expectedMs(),
                    }),
                );
            } else {
                speakerEl.textContent = isUser ? 'You' : charName;
            }

            const bubble = document.createElement('div');
            bubble.className = 'bubble';
            bubble.textContent = msg.content;

            content.append(speakerEl, bubble);

            if (!isUser && msg.content) {
                const actions = document.createElement('div');
                actions.className = 'message-actions';

                const voice = char ? char.ttsVoice : '';

                const playBtn = document.createElement('button');
                playBtn.className = 'play-btn';
                playBtn.setAttribute('aria-label', 'Play message');
                playBtn.textContent = '▶';
                playBtn.addEventListener('click', async () => {
                    try {
                        groupQueue.clear();
                        await playback.play(msg.content, voice);
                        updatePlaybackButtons();
                    } catch {
                        // silent
                    }
                });

                const stopBtn = document.createElement('button');
                stopBtn.className = 'stop-btn';
                stopBtn.setAttribute('aria-label', 'Stop playback');
                stopBtn.textContent = '■';
                stopBtn.addEventListener('click', () => {
                    groupQueue.clear();
                    playback.stop();
                    updatePlaybackButtons();
                });

                const replayBtn = document.createElement('button');
                replayBtn.className = 'replay-btn';
                replayBtn.setAttribute('aria-label', 'Replay message');
                replayBtn.textContent = '↺';
                replayBtn.addEventListener('click', async () => {
                    try {
                        groupQueue.clear();
                        await playback.replay(msg.content, voice);
                        updatePlaybackButtons();
                    } catch {
                        // silent
                    }
                });

                actions.append(playBtn, stopBtn, replayBtn);
                content.appendChild(actions);
            }

            messageEl.appendChild(content);
            messagesEl.appendChild(messageEl);
        }

        scrollMessages();
    }

    function updatePlaybackButtons() {
        const buttons = messagesEl.querySelectorAll('.message-actions');
        for (const actions of buttons) {
            const playBtn = actions.querySelector('.play-btn');
            const stopBtn = actions.querySelector('.stop-btn');
            const replayBtn = actions.querySelector('.replay-btn');
            if (playBtn) playBtn.disabled = playback.isPlaying;
            if (stopBtn) stopBtn.disabled = !playback.isPlaying;
            if (replayBtn) replayBtn.disabled = playback.isPlaying;
        }
    }

    function updateChatHeader() {
        if (!currentConversation) {
            chatTitle.textContent = 'OpenParlor';
            chatSubtitle.textContent = 'Select a conversation to begin';
            messageInput.disabled = true;
            sendButton.disabled = true;
            updateAutoSpeakButton();
            updateVoiceModeButton();
            renderParticipants();
            return;
        }
        const char = findCharacter(currentConversation.characterId);
        chatTitle.textContent = currentConversation.title;
        chatSubtitle.textContent = char ? char.name : '';
        messageInput.disabled = false;
        sendButton.disabled = false;
        updateAutoSpeakButton();
        updateVoiceModeButton();
        renderParticipants();
    }

    const scrollScheduler = createScrollScheduler((fn) => requestAnimationFrame(fn));

    function scrollMessages() {
        scrollScheduler.schedule(() => {
            messagesEl.scrollTop = messagesEl.scrollHeight;
        });
    }

    // ── Participants ───────────────────────────────────────────────────────

    const participantsBar = document.getElementById('participantsBar');
    const participantsList = document.getElementById('participantsList');
    const addParticipantButton = document.getElementById('addParticipantButton');
    const addParticipantSelect = document.getElementById('addParticipantSelect');

    function renderParticipants() {
        if (!participantsBar) return;
        if (!currentConversation) {
            participantsBar.hidden = true;
            return;
        }
        participantsBar.hidden = false;
        participantsList.innerHTML = '';

        const participants = currentConversation.participants || [];
        for (const p of participants) {
            const char = findCharacter(p.characterId);
            const chip = document.createElement('span');
            chip.className = 'participant-chip';
            chip.textContent = char ? char.name : p.characterId;

            const removeBtn = document.createElement('button');
            removeBtn.className = 'participant-remove';
            removeBtn.setAttribute('aria-label', 'Remove ' + (char ? char.name : p.characterId));
            removeBtn.textContent = '×';
            removeBtn.addEventListener('click', async () => {
                const remaining = participants.filter(x => x.characterId !== p.characterId);
                if (remaining.length === 0) return;
                await updateParticipants(remaining.map(x => x.characterId));
            });

            chip.appendChild(removeBtn);
            participantsList.appendChild(chip);
        }

        // Populate add-select with characters not already participants
        if (addParticipantSelect) {
            addParticipantSelect.innerHTML = '<option value="">Add character…</option>';
            const participantIds = new Set(participants.map(p => p.characterId));
            for (const char of characters) {
                if (participantIds.has(char.id)) continue;
                const opt = document.createElement('option');
                opt.value = char.id;
                opt.textContent = char.name;
                addParticipantSelect.appendChild(opt);
            }
            addParticipantSelect.disabled = participants.length >= 10;
        }
    }

    async function updateParticipants(characterIds) {
        try {
            const token = await getCsrfToken();
            const res = await fetch('/api/openparlor/conversations/' + encodeURIComponent(currentConversation.id) + '/participants', {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': token,
                },
                body: JSON.stringify({ character_ids: characterIds }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(normalizeServiceError(err, 'Failed to update participants'));
            }
            const updated = normalizeConversation(await res.json());
            currentConversation = updated;
            renderParticipants();
            renderConversations();
        } catch (e) {
            renderState(messagesEl, 'error', e.message || 'Failed to update participants.');
        }
    }

    if (addParticipantButton) {
        addParticipantButton.addEventListener('click', () => {
            if (!addParticipantSelect || !addParticipantSelect.value) return;
            const currentIds = (currentConversation.participants || []).map(p => p.characterId);
            const newIds = [...currentIds, addParticipantSelect.value];
            updateParticipants(newIds);
        });
    }

    // ── API helpers ────────────────────────────────────────────────────────

    async function fetchModelStatus() {
        try {
            const res = await fetch('/api/openparlor/model-status');
            if (!res.ok) throw new Error('Failed to load model status');
            const data = await res.json();
            return normalizeModelStatus(data);
        } catch {
            return normalizeModelStatus(null);
        }
    }

    function renderModelStatus(status) {
        if (!modelStatusDot || !modelStatusBody) return;

        modelStatusDot.className = 'model-status-dot' + (status.connected ? ' connected' : ' unavailable');

        modelStatusBody.innerHTML = '';

        if (!status.provider && !status.model) {
            const el = document.createElement('div');
            el.className = 'model-status-unavailable';
            el.textContent = 'No model configured';
            modelStatusBody.appendChild(el);
            return;
        }

        if (status.model) {
            const modelEl = document.createElement('div');
            modelEl.className = 'model-status-model';
            modelEl.textContent = status.model;
            modelStatusBody.appendChild(modelEl);
        }

        if (status.endpointLabel) {
            const endpointEl = document.createElement('div');
            endpointEl.className = 'model-status-endpoint';
            endpointEl.textContent = status.endpointLabel;
            modelStatusBody.appendChild(endpointEl);
        }

        if (status.connected && status.models.length > 0) {
            const modelsEl = document.createElement('div');
            modelsEl.className = 'model-status-models';
            modelsEl.textContent = status.models.slice(0, 5).join(', ');
            if (status.models.length > 5) {
                modelsEl.textContent += ` +${status.models.length - 5} more`;
            }
            modelStatusBody.appendChild(modelsEl);
        } else if (!status.connected) {
            const unavailableEl = document.createElement('div');
            unavailableEl.className = 'model-status-unavailable';
            unavailableEl.textContent = 'Unavailable';
            modelStatusBody.appendChild(unavailableEl);
        }
    }

    // ── Health status ──────────────────────────────────────────────────────

    const healthStatusList = document.getElementById('healthStatusList');
    const prerequisiteStatus = document.getElementById('prerequisiteStatus');

    async function fetchHealthStatus() {
        try {
            const res = await fetch('/api/openparlor/health');
            if (!res.ok) throw new Error('Failed to load health status');
            const data = await res.json();
            return normalizeHealthStatus(data);
        } catch {
            return normalizeHealthStatus(null);
        }
    }

    function renderHealthStatus(status) {
        if (!healthStatusList) return;
        healthStatusList.innerHTML = '';

        const services = [
            { key: 'model', name: 'Model' },
            { key: 'tts', name: 'TTS' },
            { key: 'stt', name: 'STT' },
        ];

        for (const svc of services) {
            const item = document.createElement('div');
            item.className = 'health-item';

            const service = status[svc.key];
            const available = service ? service.available : false;

            item.setAttribute('role', 'status');
            item.setAttribute('aria-label', svc.name + (available ? ' available' : ' unavailable'));

            const dot = document.createElement('span');
            dot.className = 'health-dot' + (available ? ' available' : ' unavailable');
            dot.setAttribute('aria-hidden', 'true');

            const label = document.createElement('span');
            label.className = 'health-label';
            label.textContent = svc.name + (available ? '' : ' — unavailable');

            item.append(dot, label);
            healthStatusList.appendChild(item);
        }
    }

    function renderPrerequisiteStatus(status) {
        if (!prerequisiteStatus) return;
        prerequisiteStatus.innerHTML = '';
        if (status.deferred) {
            const el = document.createElement('div');
            el.className = 'prerequisite-deferred';
            el.textContent = status.label;
            prerequisiteStatus.appendChild(el);
        }
    }

    async function getCsrfToken() {
        const res = await fetch('/csrf-token');
        if (!res.ok) throw new Error('Unable to get CSRF token');
        const data = await res.json();
        if (typeof data.token !== 'string' || !data.token) {
            throw new Error('Invalid CSRF token');
        }
        return data.token;
    }

    async function fetchCharacters() {
        const res = await fetch('/api/openparlor/characters?include_archived=true');
        if (!res.ok) throw new Error('Failed to load characters');
        const data = await res.json();
        allCharacters = (Array.isArray(data) ? data : []).map(normalizeCharacter).filter(Boolean);
        // Archived characters stay resolvable for history but are hidden from
        // normal new-chat selection.
        characters = allCharacters.filter(c => !c.archived);
    }

    // Resolves a character by id across active and archived characters, so
    // historical conversations and memories of archived characters keep
    // rendering names and avatars.
    function findCharacter(id) {
        return allCharacters.find(c => c.id === id);
    }

    async function fetchConversations() {
        const res = await fetch('/api/openparlor/conversations');
        if (!res.ok) throw new Error('Failed to load conversations');
        const data = await res.json();
        conversations = (Array.isArray(data) ? data : []).map(normalizeConversation).filter(Boolean);
        conversations.sort((a, b) => {
            const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
            const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
            return tb - ta;
        });
    }

    async function fetchConversation(id) {
        const res = await fetch('/api/openparlor/conversations/' + encodeURIComponent(id));
        if (!res.ok) throw new Error('Failed to load conversation');
        const data = await res.json();
        currentConversation = normalizeConversation(data);
        currentMessages = Array.isArray(data.messages) ? data.messages : [];
    }

    async function createConversation(characterId, title) {
        const token = await getCsrfToken();
        const res = await fetch('/api/openparlor/conversations', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': token,
            },
            body: JSON.stringify({ character_id: characterId, title: title }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(normalizeServiceError(err, 'Failed to create conversation'));
        }
        return normalizeConversation(await res.json());
    }

    async function createCharacter(name, avatarUrl, ttsVoice) {
        const token = await getCsrfToken();
        const res = await fetch('/api/openparlor/characters', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': token,
            },
            body: JSON.stringify({ name, avatar_url: avatarUrl, tts_voice: ttsVoice }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(normalizeServiceError(err, 'Failed to create character'));
        }
        return normalizeCharacter(await res.json());
    }

    async function updateCharacter(id, name, avatarUrl, ttsVoice) {
        const token = await getCsrfToken();
        const res = await fetch('/api/openparlor/characters/' + encodeURIComponent(id), {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': token,
            },
            body: JSON.stringify({ name, avatar_url: avatarUrl, tts_voice: ttsVoice }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(normalizeServiceError(err, 'Failed to update character'));
        }
        return normalizeCharacter(await res.json());
    }

    async function uploadCharacterAvatar(file) {
        if (!file) return '';
        const allowedTypes = new Map([
            ['image/bmp', 'bmp'],
            ['image/png', 'png'],
            ['image/jpeg', 'jpg'],
            ['image/webp', 'webp'],
            ['image/gif', 'gif'],
            ['image/jfif', 'jfif'],
        ]);
        const format = allowedTypes.get(file.type);
        if (!format) throw new Error('Choose a PNG, JPEG, GIF, WebP, BMP, or JFIF image.');
        if (file.size > 5 * 1024 * 1024) throw new Error('Avatar images must be 5 MB or smaller.');

        const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('Unable to read the avatar image.'));
            reader.readAsDataURL(file);
        });
        const comma = dataUrl.indexOf(',');
        if (comma < 0) throw new Error('Invalid avatar image data.');

        const token = await getCsrfToken();
        const res = await fetch('/api/images/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
            body: JSON.stringify({
                image: dataUrl.slice(comma + 1),
                format,
                filename: `openparlor-avatar-${Date.now()}.${format}`,
            }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(normalizeServiceError(err, 'Failed to upload avatar'));
        }
        const data = await res.json();
        if (typeof data.path !== 'string' || !data.path.startsWith('/')) throw new Error('Avatar upload returned an invalid path.');
        return data.path;
    }

    async function deleteCharacter(id) {
        const token = await getCsrfToken();
        const res = await fetch('/api/openparlor/characters/' + encodeURIComponent(id), {
            method: 'DELETE',
            headers: { 'X-CSRF-Token': token },
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(normalizeServiceError(err, 'Failed to delete character'));
        }
        // 204 → hard delete. 200 + JSON → character was archived (still referenced).
        if (res.status === 204) return { deleted: true, archived: false, character: null };
        const data = await res.json().catch(() => ({}));
        return {
            deleted: false,
            archived: data.archived === true,
            character: data.character ? normalizeCharacter(data.character) : null,
        };
    }

    async function renameConversation(id, title) {
        const token = await getCsrfToken();
        const res = await fetch('/api/openparlor/conversations/' + encodeURIComponent(id), {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': token,
            },
            body: JSON.stringify({ title }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(normalizeServiceError(err, 'Failed to rename conversation'));
        }
        return normalizeConversation(await res.json());
    }

    async function deleteConversation(id) {
        const token = await getCsrfToken();
        const res = await fetch('/api/openparlor/conversations/' + encodeURIComponent(id), {
            method: 'DELETE',
            headers: { 'X-CSRF-Token': token },
        });
        if (!res.ok && res.status !== 204) {
            const err = await res.json().catch(() => ({}));
            throw new Error(normalizeServiceError(err, 'Failed to delete conversation'));
        }
    }

    let characterNoticeTimer = null;
    function showCharacterNotice(text) {
        const existing = characterList.querySelector('.character-notice');
        if (existing) existing.remove();
        if (characterNoticeTimer) {
            clearTimeout(characterNoticeTimer);
            characterNoticeTimer = null;
        }
        const notice = document.createElement('div');
        notice.className = 'character-notice';
        notice.textContent = text;
        characterList.prepend(notice);
        characterNoticeTimer = setTimeout(() => {
            notice.remove();
            characterNoticeTimer = null;
        }, 6000);
    }

    // ── Character card import/export ───────────────────────────────────────

    const MAX_CARD_IMPORT_BYTES = 16 * 1024 * 1024;

    function isImportableCardFile(file) {
        if (!file || typeof file.size !== 'number' || file.size === 0) return false;
        if (file.size > MAX_CARD_IMPORT_BYTES) return false;
        const name = (file.name || '').toLowerCase();
        if (name.endsWith('.json') || name.endsWith('.png')) return true;
        return file.type === 'application/json' || file.type === 'image/png';
    }

    async function importCharacterCard(file) {
        if (!isImportableCardFile(file)) {
            showCharacterNotice('Import failed: choose a character card file (.json or .png) of 16 MB or less.');
            return;
        }
        importCharacterButton.disabled = true;
        try {
            const token = await getCsrfToken();
            const form = new FormData();
            form.append('file', file);
            const res = await fetch('/api/openparlor/characters/import', {
                method: 'POST',
                headers: { 'X-CSRF-Token': token },
                body: form,
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(normalizeServiceError(data, 'Failed to import character card'));
            }
            const imported = normalizeCharacter(data);
            if (!imported || !imported.id) throw new Error('Import returned an invalid character');
            allCharacters.push(imported);
            characters.push(imported); // imported characters are active
            renderCharacters();
            showCharacterNotice(`Imported ${imported.name}.`);
        } catch (e) {
            showCharacterNotice('Import failed: ' + (e.message || 'unknown error'));
        } finally {
            importCharacterButton.disabled = false;
        }
    }

    async function exportCharacterCard() {
        if (!editingCharacterId) return;
        const character = findCharacter(editingCharacterId);
        charExportButton.disabled = true;
        try {
            const res = await fetch('/api/openparlor/characters/' + encodeURIComponent(editingCharacterId) + '/export');
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(normalizeServiceError(err, 'Failed to export character card'));
            }
            const blob = await res.blob();
            const filename = buildCardExportFilename(res.headers.get('Content-Disposition'), character ? character.name : '');
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = filename;
            anchor.rel = 'noopener';
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            URL.revokeObjectURL(url);
        } catch (e) {
            showFormError(e.message || 'Failed to export character card');
        } finally {
            charExportButton.disabled = false;
        }
    }

    async function fetchTtsVoices() {
        try {
            const res = await fetch('/api/openparlor/tts/voices');
            if (!res.ok) throw new Error('Failed to load TTS voices');
            ttsVoices = normalizeTtsVoices(await res.json());
        } catch {
            ttsVoices = { voices: [], available: false };
        }
    }

    // ── Memory panel ───────────────────────────────────────────────────────

    const memoryPanel = document.getElementById('memoryPanel');
    const memorySection = document.getElementById('memorySection');
    const memoryRefreshGuard = createMemoryRefreshGuard();
    let memories = [];
    let editingMemoryId = null;

    function invalidateMemoryState() {
        memoryRefreshGuard.begin();
        memories = [];
        renderMemoryPanel();
    }


    async function updateMemoryApi(id, body) {
        const token = await getCsrfToken();
        const res = await fetch('/api/openparlor/memories/' + encodeURIComponent(id), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(normalizeServiceError(err, 'Failed to update memory'));
        }
        return normalizeMemory(await res.json());
    }

    async function deleteMemoryApi(id) {
        const token = await getCsrfToken();
        const res = await fetch('/api/openparlor/memories/' + encodeURIComponent(id), {
            method: 'DELETE',
            headers: { 'X-CSRF-Token': token },
        });
        if (!res.ok && res.status !== 204) {
            const err = await res.json().catch(() => ({}));
            throw new Error(normalizeServiceError(err, 'Failed to delete memory'));
        }
    }

    async function pinMemoryApi(id, pinned) {
        const token = await getCsrfToken();
        const res = await fetch('/api/openparlor/memories/' + encodeURIComponent(id) + '/pin', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
            body: JSON.stringify({ pinned }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(normalizeServiceError(err, 'Failed to pin memory'));
        }
        return normalizeMemory(await res.json());
    }

    function renderMemoryPanel() {
        if (!memoryPanel) return;

        const visible = shouldShowMemorySection({
            hasConversation: !!currentConversation,
            hasCharacter: !!(currentConversation && currentConversation.characterId),
            memoryCount: memories.length,
        });

        if (memorySection) memorySection.hidden = !visible;
        if (!visible) return;

        memoryPanel.innerHTML = '';

        for (const mem of memories) {
            const row = document.createElement('div');
            row.className = 'memory-row' + (mem.pinned ? ' pinned' : '');
            row.dataset.id = mem.id;

            if (editingMemoryId === mem.id) {
                renderMemoryEditForm(row, mem);
            } else {
                renderMemoryDisplay(row, mem);
            }

            memoryPanel.appendChild(row);
        }
    }

    function renderMemoryDisplay(row, mem) {
        const source = normalizeMemorySource(mem, conversations);

        const contentEl = document.createElement('div');
        contentEl.className = 'memory-content';
        contentEl.textContent = mem.content.length > 120 ? mem.content.slice(0, 120) + '…' : mem.content;

        const metaEl = document.createElement('div');
        metaEl.className = 'memory-meta';

        const typeBadge = document.createElement('span');
        typeBadge.className = 'memory-type memory-type-' + mem.type;
        typeBadge.textContent = mem.type;

        const importanceEl = document.createElement('span');
        importanceEl.className = 'memory-importance';
        importanceEl.textContent = '★'.repeat(Math.round(mem.importance * 4) + 1);

        metaEl.append(typeBadge, importanceEl);

        const sourceEl = document.createElement('div');
        sourceEl.className = 'memory-source';
        sourceEl.textContent = source.label;
        if (!source.available) {
            sourceEl.classList.add('memory-source-unavailable');
        }

        const actionsEl = document.createElement('div');
        actionsEl.className = 'memory-actions';

        const pinBtn = document.createElement('button');
        pinBtn.className = 'memory-action-btn pin-btn' + (mem.pinned ? ' active' : '');
        pinBtn.title = mem.pinned ? 'Unpin' : 'Pin';
        pinBtn.textContent = mem.pinned ? '📌' : '📍';
        pinBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            try {
                const updated = await pinMemoryApi(mem.id, !mem.pinned);
                const idx = memories.findIndex(m => m.id === mem.id);
                if (idx !== -1) memories[idx] = updated;
                memories.sort((a, b) => {
                    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
                    return b.importance - a.importance;
                });
                renderMemoryPanel();
            } catch { /* silent */ }
        });

        const editBtn = document.createElement('button');
        editBtn.className = 'memory-action-btn edit-btn';
        editBtn.title = 'Edit';
        editBtn.textContent = '✎';
        editBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            editingMemoryId = mem.id;
            renderMemoryPanel();
        });

        const delBtn = document.createElement('button');
        delBtn.className = 'memory-action-btn delete-btn';
        delBtn.title = 'Delete';
        delBtn.textContent = '✕';
        delBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            try {
                await deleteMemoryApi(mem.id);
                memories = memories.filter(m => m.id !== mem.id);
                renderMemoryPanel();
            } catch { /* silent */ }
        });

        actionsEl.append(pinBtn, editBtn, delBtn);
        row.append(contentEl, metaEl, sourceEl, actionsEl);
    }

    function renderMemoryEditForm(row, mem) {
        const form = document.createElement('div');
        form.className = 'memory-edit-form';

        const textarea = document.createElement('textarea');
        textarea.className = 'memory-edit-content';
        textarea.rows = 3;
        textarea.maxLength = 2000;
        textarea.value = mem.content;
        textarea.placeholder = 'Memory content…';

        const typeSelect = document.createElement('select');
        typeSelect.className = 'memory-edit-type';
        for (const t of ['fact', 'preference', 'event', 'relationship', 'other']) {
            const opt = document.createElement('option');
            opt.value = t;
            opt.textContent = t;
            typeSelect.appendChild(opt);
        }
        typeSelect.value = mem.type;

        const importanceInput = document.createElement('input');
        importanceInput.type = 'range';
        importanceInput.className = 'memory-edit-importance';
        importanceInput.min = '0';
        importanceInput.max = '1';
        importanceInput.step = '0.05';
        importanceInput.value = String(mem.importance);

        const importanceLabel = document.createElement('span');
        importanceLabel.className = 'memory-importance-value';
        importanceLabel.textContent = String(mem.importance);
        importanceInput.addEventListener('input', () => {
            importanceLabel.textContent = importanceInput.value;
        });

        const errorEl = document.createElement('div');
        errorEl.className = 'memory-edit-error';
        errorEl.hidden = true;

        const actions = document.createElement('div');
        actions.className = 'memory-edit-actions';

        const saveBtn = document.createElement('button');
        saveBtn.className = 'memory-edit-save';
        saveBtn.textContent = 'Save';
        saveBtn.addEventListener('click', async () => {
            const validation = validateMemoryForm({
                content: textarea.value,
                type: typeSelect.value,
                importance: Number(importanceInput.value),
            });
            if (!validation.valid) {
                errorEl.textContent = validation.errors.join(' ');
                errorEl.hidden = false;
                return;
            }
            try {
                saveBtn.disabled = true;
                const updated = await updateMemoryApi(mem.id, {
                    content: validation.content,
                    type: validation.type,
                    importance: validation.importance,
                });
                const idx = memories.findIndex(m => m.id === mem.id);
                if (idx !== -1) memories[idx] = updated;
                editingMemoryId = null;
                renderMemoryPanel();
            } catch (e) {
                errorEl.textContent = e.message || 'Failed to save';
                errorEl.hidden = false;
            } finally {
                saveBtn.disabled = false;
            }
        });

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'memory-edit-cancel';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => {
            editingMemoryId = null;
            renderMemoryPanel();
        });

        actions.append(saveBtn, cancelBtn);
        form.append(textarea, typeSelect, importanceInput, importanceLabel, errorEl, actions);
        row.appendChild(form);
    }

    async function refreshMemoryPanel() {
        // Immediately clear visible state so prior-conversation memories
        // cannot linger while the new fetch is in flight.
        memories = [];
        renderMemoryPanel();

        if (!currentConversation || !currentConversation.characterId) return;

        const gen = memoryRefreshGuard.begin();
        const charId = currentConversation.characterId;

        try {
            const res = await fetch('/api/openparlor/memories?character_id=' + encodeURIComponent(charId));
            if (!res.ok) throw new Error('Failed to load memories');
            const data = await res.json();
            // Stale guard: discard if a newer refresh started or conversation changed.
            if (!memoryRefreshGuard.isCurrent(gen)) return;
            if (!currentConversation || currentConversation.characterId !== charId) return;
            memories = (Array.isArray(data) ? data : []).map(normalizeMemory).filter(Boolean);
            memories.sort((a, b) => {
                if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
                return b.importance - a.importance;
            });
        } catch {
            if (!memoryRefreshGuard.isCurrent(gen)) return;
            memories = [];
        }
        renderMemoryPanel();
    }

    // ── Actions ────────────────────────────────────────────────────────────

    async function handleCharacterFormSubmit() {
        const rawName = charNameInput.value;
        const rawAvatar = charAvatarInput.value;

        const validation = validateCharacterForm({ name: rawName });
        if (!validation.valid) {
            showFormError(validation.errors.join(' '));
            return;
        }

        const rawVoice = charVoiceSelect.value;
        const sanitized = sanitizeCharacterInput({ name: rawName, avatar_url: rawAvatar, tts_voice: rawVoice });

        try {
            charFormSave.disabled = true;
            const uploadedAvatarUrl = await uploadCharacterAvatar(charAvatarFileInput.files[0]);
            const avatarUrl = uploadedAvatarUrl || sanitized.avatarUrl;
            let saved;
            if (editingCharacterId) {
                saved = await updateCharacter(editingCharacterId, sanitized.name, avatarUrl, sanitized.ttsVoice);
                // Keep both arrays in sync: cards render from allCharacters,
                // new-chat selection from characters (active only).
                const allIdx = allCharacters.findIndex(c => c.id === saved.id);
                if (allIdx !== -1) allCharacters[allIdx] = saved;
                const idx = characters.findIndex(c => c.id === saved.id);
                if (idx !== -1) characters[idx] = saved;
            } else {
                saved = await createCharacter(sanitized.name, avatarUrl, sanitized.ttsVoice);
                allCharacters.push(saved);
                characters.push(saved); // new characters are active
            }
            hideCharacterForm();
            renderCharacters();
        } catch (e) {
            showFormError(e.message || 'Something went wrong');
        } finally {
            charFormSave.disabled = false;
        }
    }

    function characterHasLocalHistory(characterId) {
        return conversations.some(conv => conv.characterId === characterId
            || (conv.participants || []).some(p => p.characterId === characterId));
    }

    async function handleDeleteCharacter(character) {
        // The server is authoritative: referenced characters are archived
        // (200 + JSON), unreferenced ones are hard-deleted (204). The local
        // history check only tunes the confirmation wording.
        const hasHistory = characterHasLocalHistory(character.id);
        const message = hasHistory
            ? `${character.name} has conversations. Deleting it will archive the character: it will be hidden from new chats, but existing conversations and memories stay intact. Continue?`
            : `Delete ${character.name}? This cannot be undone.`;
        if (!window.confirm(message)) return;
        try {
            const result = await deleteCharacter(character.id);
            if (editingCharacterId === character.id) hideCharacterForm();
            if (result.archived && result.character) {
                // Character was archived: keep it resolvable for history.
                const idx = allCharacters.findIndex(item => item.id === character.id);
                if (idx !== -1) allCharacters[idx] = result.character;
                characters = allCharacters.filter(item => !item.archived);
                renderCharacters();
                renderConversations();
                showCharacterNotice(`${result.character.name} was archived — its conversations and memories are preserved.`);
                return;
            }
            if (result.deleted) {
                allCharacters = allCharacters.filter(item => item.id !== character.id);
                characters = characters.filter(item => item.id !== character.id);
                // A hard delete only happens for unreferenced characters, so no
                // open conversation can reference this id anymore.
                renderCharacters();
                renderConversations();
            }
        } catch (e) {
            showFormError(e.message || 'Failed to delete character');
            characterForm.hidden = false;
        }
    }

    function handleRenameConversation(conv, item) {
        const titleEl = item.querySelector('.conversation-title');
        if (!titleEl) return;

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'conversation-rename-input';
        input.value = conv.title;
        input.maxLength = 200;
        input.setAttribute('aria-label', 'Rename conversation');

        titleEl.replaceWith(input);
        input.focus();
        input.select();

        let settled = false;

        const errorEl = document.createElement('div');
        errorEl.className = 'conversation-rename-error';
        errorEl.hidden = true;
        item.appendChild(errorEl);

        function commit() {
            if (settled) return;
            const validation = validateConversationTitle(input.value);
            if (!validation.valid) {
                errorEl.textContent = validation.error;
                errorEl.hidden = false;
                input.focus();
                return;
            }
            settled = true;
            renameConversation(conv.id, validation.title).then(updated => {
                const idx = conversations.findIndex(c => c.id === conv.id);
                if (idx !== -1) conversations[idx] = updated;
                if (currentConversation && currentConversation.id === conv.id) {
                    currentConversation = updated;
                    updateChatHeader();
                }
                renderConversations();
            }).catch(() => {
                renderConversations();
            });
        }

        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                e.preventDefault();
                commit();
            } else if (e.key === 'Escape') {
                settled = true;
                renderConversations();
            }
        });
        input.addEventListener('blur', commit);
        input.addEventListener('click', e => e.stopPropagation());
    }

    async function handleDeleteConversation(conv) {
        if (!window.confirm('Delete "' + conv.title + '"? This cannot be undone.')) return;
        const isCurrent = currentConversation && currentConversation.id === conv.id;

        // Neutralize active response UI before awaiting the DELETE fetch so
        // server latency cannot allow an old stream to update the UI.
        if (isCurrent) {
            if (streamAbortController) {
                streamAbortController.abort();
                streamAbortController = null;
            }
            groupQueue.clear();
            playback.stop();
            voiceTurnTimer.cancel();
            recorder.cancel();
            isSending = false;
            sendButton.disabled = true;
            messageInput.disabled = true;
            updatePlaybackButtons();
            updateRecorderUI();
            updateTranscriptionStatus();
            invalidateMemoryState();
            stopPendingStart();
        }

        try {
            await deleteConversation(conv.id);
            conversations = conversations.filter(c => c.id !== conv.id);

            if (isCurrent) {
                // Clear per-conversation localStorage
                try {
                    localStorage.removeItem('openparlor-auto-speak-' + conv.id);
                    localStorage.removeItem('openparlor-voice-mode-' + conv.id);
                } catch { /* storage unavailable */ }
                // Clear current state
                currentConversation = null;
                currentMessages = [];
                memories = [];

                // Select another conversation or show empty state
                if (conversations.length > 0) {
                    await selectConversation(conversations[0].id);
                } else {
                    renderConversations();
                    renderMessages();
                    updateChatHeader();
                    renderParticipants();
                    renderMemoryPanel();
                }
            } else {
                renderConversations();
            }
        } catch (e) {
            if (isCurrent && currentConversation && currentConversation.id === conv.id) {
                isSending = false;
                sendButton.disabled = false;
                messageInput.disabled = false;
                renderMessages();
                updateChatHeader();
            }
        }
    }

    async function selectConversation(id) {
        selectionEpoch++;
        groupQueue.clear();
        playback.stop();
        voiceTurnTimer.cancel();
        stopPendingStart();
        invalidateMemoryState();
        try {
            renderState(messagesEl, 'loading', 'Loading…');
            await fetchConversation(id);
            renderConversations();
            renderMessages();
            updateChatHeader();
            refreshMemoryPanel();
        } catch (e) {
            renderState(messagesEl, 'error', 'Failed to load conversation.');
        }
    }

    async function handleNewConversation() {
        const charId = characterSelect.value;
        if (!charId) {
            renderState(messagesEl, 'error', 'Select a character before starting a conversation.');
            return;
        }

        const char = characters.find(c => c.id === charId);
        const title = char ? 'Chat with ' + char.name : 'New conversation';

        try {
            newChatButton.disabled = true;
            invalidateMemoryState();
            stopPendingStart();
            const conv = await createConversation(charId, title);
            conversations.unshift(conv);
            currentConversation = conv;
            currentMessages = [];
            renderConversations();
            renderMessages();
            updateChatHeader();
            refreshMemoryPanel();
        } catch (e) {
            renderState(messagesEl, 'error', 'Failed to create conversation.');
        } finally {
            newChatButton.disabled = false;
        }
    }

    // ── Estimated response-start progress (DOGFOOD-007) ────────────────────
    //
    // Rough visual estimate of time-to-first-token while a speaker is being
    // prepared. Not real model progress: the ratio caps below 100%, the
    // label is marked with "~", and the indicator is removed on the first
    // visible token or cancelled on stop/abort/switch/error/completion.

    function startPendingStart(msg, name) {
        pendingStart = { msg, startedAt: performance.now(), name: name || '' };
        if (progressTimerId === null) {
            progressTimerId = setInterval(tickPendingStart, 200);
        }
    }

    function stopPendingStart() {
        pendingStart = null;
        if (progressTimerId !== null) {
            clearInterval(progressTimerId);
            progressTimerId = null;
        }
    }

    // Fold the observed first-token latency into the browser-local estimate
    // and remove the indicator; the delta path only updates the bubble, so
    // the speaker label is fixed up here.
    function completePendingStart(msg, bubble) {
        if (!pendingStart || pendingStart.msg !== msg) return;
        const name = pendingStart.name;
        firstTokenEstimator.observe(performance.now() - pendingStart.startedAt);
        stopPendingStart();
        if (name && bubble) {
            const content = bubble.closest('.message-content');
            const speaker = content ? content.querySelector('.speaker-progress') : null;
            if (speaker) speaker.textContent = name;
        }
    }

    function tickPendingStart() {
        if (!pendingStart) {
            stopPendingStart();
            return;
        }
        const speaker = messagesEl.querySelector('.speaker-progress');
        if (!speaker) return;
        speaker.textContent = formatResponseStartProgress(
            pendingStart.name,
            estimateResponseStartProgress({
                elapsedMs: performance.now() - pendingStart.startedAt,
                expectedMs: firstTokenEstimator.expectedMs(),
            }),
        );
    }

    async function sendMessage() {
        const text = messageInput.value.trim();
        if (!text || isSending || !currentConversation) return;

        const sendConversationId = currentConversation.id;
        const sendEpoch = selectionEpoch;

        isSending = true;
        sendButton.disabled = true;
        messageInput.value = '';
        voiceTurnTimer.markSendStart();

        // Append user message locally
        currentMessages.push({ role: 'user', content: text });
        renderMessages();

        // Create assistant bubble placeholder; the server's first
        // speaker_start determines the actual character identity before any
        // text is shown.
        const assistantMsgStartIndex = currentMessages.length;
        const streamCollector = createStreamMessageCollector();
        let currentAssistantMsg = streamCollector.getPendingMessage();
        currentMessages.push(currentAssistantMsg);
        renderMessages();
        // The first speaker's pending window starts at send time: that is
        // when waiting for visible text begins (identity may be unknown).
        startPendingStart(currentAssistantMsg, '');

        let lastBubble = messagesEl.querySelector('.message:last-child .bubble');
        const abortController = new AbortController();
        streamAbortController = abortController;

        try {
            const token = await getCsrfToken();
            const response = await fetch('/api/openparlor/chat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': token,
                },
                body: JSON.stringify({
                    // The server owns persisted history; send only the new
                    // user turn so history is never duplicated.
                    messages: [{ role: 'user', content: text }],
                    stream: true,
                    conversation_id: currentConversation.id,
                }),
                signal: abortController.signal,
            });

            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                currentAssistantMsg.content = normalizeServiceError(err, 'Request failed');
                if (lastBubble) lastBubble.textContent = currentAssistantMsg.content;
                renderMessages();
                scrollMessages();
                stopPendingStart();
                if (isDev) voiceTurnTimer.log();
                voiceTurnTimer.cancel();
                return;
            }

            const parser = createNdjsonParser();
            const reader = response.body.getReader();
            let processedCount = 0;
            let streamDone = false;
            let hadStreamError = false;

            function processNewRecords() {
                for (let i = processedCount; i < parser.records.length; i++) {
                    const record = parser.records[i];
                    if (record.type === 'done') {
                        streamDone = true;
                        break;
                    }
                    const outcome = streamCollector.handleRecord(record);
                    if (outcome === null) continue;
                    if (outcome.type === 'speaker_start') {
                        currentAssistantMsg = outcome.message;
                        if (outcome.isNewMessage) {
                            currentMessages.push(currentAssistantMsg);
                            // Each speaker in a sequential reply waits for
                            // its own first token: fresh pending state so
                            // progress never carries across speakers.
                            const speakerChar = findCharacter(resolveMessageCharacterId(currentAssistantMsg, currentConversation));
                            startPendingStart(currentAssistantMsg, speakerChar ? speakerChar.name : '');
                        } else if (pendingStart && pendingStart.msg === currentAssistantMsg) {
                            // First speaker: identity was assigned to the
                            // existing pending message. Keep the window
                            // running from send time; only attach the name.
                            const speakerChar = findCharacter(resolveMessageCharacterId(currentAssistantMsg, currentConversation));
                            pendingStart.name = speakerChar ? speakerChar.name : '';
                        }
                        // Re-render on every speaker_start so the
                        // server-identified speaker is displayed before the
                        // first text delta of that bubble.
                        renderMessages();
                        lastBubble = messagesEl.querySelector('.message:last-child .bubble');
                    } else if (outcome.type === 'delta') {
                        if (pendingStart && pendingStart.msg === currentAssistantMsg) {
                            completePendingStart(currentAssistantMsg, lastBubble);
                        }
                        voiceTurnTimer.markFirstToken();
                        if (lastBubble) lastBubble.textContent = currentAssistantMsg.content;
                        scrollMessages();
                    } else if (outcome.type === 'error') {
                        hadStreamError = true;
                        stopPendingStart();
                        if (lastBubble) lastBubble.textContent = currentAssistantMsg.content;
                        scrollMessages();
                    }
                }
                processedCount = parser.records.length;
            }

            while (!streamDone) {
                const { done, value } = await reader.read();
                if (done) break;
                parser.feed(value);
                processNewRecords();
            }

            parser.flush();
            processNewRecords();
            if (streamDone) voiceTurnTimer.markStreamComplete();
            // Final full render: the delta path only updates the live bubble
            // text, so completed messages need a re-render to gain their TTS
            // controls and server-identified speaker.
            renderMessages();

            // Auto-speak: queue completed group replies for sequential playback
            let ttsHandled = false;
            ttsMarkedForTurn = false;
            if (
                shouldAutoSpeak({
                    sendConversationId,
                    currentConversationId: currentConversation ? currentConversation.id : '',
                    sendEpoch,
                    selectionEpoch,
                    streamDone,
                    hadStreamError,
                    autoSpeakEnabled: getAutoSpeakState(sendConversationId) || getVoiceModeState(sendConversationId),
                    hasContent: currentMessages.slice(assistantMsgStartIndex).some(m => m.content),
                    recordingActive: recorder.state === 'recording' || recordingInterruptionPending,
                })
            ) {
                const turnMessages = currentMessages.slice(assistantMsgStartIndex);
                for (const msg of turnMessages) {
                    if (!msg.content) continue;
                    const charId = msg.character_id || currentConversation.characterId;
                    const char = findCharacter(charId);
                    const voice = char ? char.ttsVoice : '';
                    if (voice) {
                        groupQueue.enqueue(msg.content, voice);
                    }
                }
                if (groupQueue.pending > 0) {
                    ttsHandled = true;
                    groupQueue.playAll().catch(() => {});
                    updatePlaybackButtons();
                }
            }
            if (!ttsHandled) {
                if (isDev) voiceTurnTimer.log();
                voiceTurnTimer.cancel();
            }
        } catch (e) {
            if (e && e.name === 'AbortError') {
                stopPendingStart();
                return;
            }
            currentAssistantMsg.content = 'Connection error';
            if (lastBubble) lastBubble.textContent = currentAssistantMsg.content;
            renderMessages();
            scrollMessages();
            stopPendingStart();
            if (isDev) voiceTurnTimer.log();
            voiceTurnTimer.cancel();
        } finally {
            // Clear this stream's pending state on completion; the guard
            // keeps a newer conversation's state (if any) untouched.
            if (pendingStart && pendingStart.msg === currentAssistantMsg) {
                stopPendingStart();
            }
            if (streamAbortController === abortController) {
                streamAbortController = null;
                isSending = false;
                sendButton.disabled = false;
            }
        }
    }

    // ── Event listeners ────────────────────────────────────────────────────

    newChatButton.addEventListener('click', handleNewConversation);

    sendButton.addEventListener('click', sendMessage);

    messageInput.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            sendMessage();
        }
    });

    newCharacterButton.addEventListener('click', () => showCharacterForm(null));

    importCharacterButton.addEventListener('click', () => {
        importCharacterFileInput.value = '';
        importCharacterFileInput.click();
    });
    importCharacterFileInput.addEventListener('change', () => {
        const file = importCharacterFileInput.files && importCharacterFileInput.files[0];
        if (file) importCharacterCard(file);
        importCharacterFileInput.value = '';
    });

    charExportButton.addEventListener('click', exportCharacterCard);

    charFormSave.addEventListener('click', handleCharacterFormSubmit);

    charFormCancel.addEventListener('click', hideCharacterForm);

    charNameInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            handleCharacterFormSubmit();
        }
    });

    if (autoSpeakButton) {
        autoSpeakButton.addEventListener('click', () => {
            if (!currentConversation) return;
            const newState = !getAutoSpeakState(currentConversation.id);
            setAutoSpeakState(currentConversation.id, newState);
            if (!newState) {
                groupQueue.clear();
                playback.stop();
                updatePlaybackButtons();
            }
            updateAutoSpeakButton();
        });
    }

    if (voiceModeButton) {
        voiceModeButton.addEventListener('click', () => {
            if (!currentConversation) return;
            const newState = !getVoiceModeState(currentConversation.id);
            setVoiceModeState(currentConversation.id, newState);
            if (!newState) {
                groupQueue.clear();
                playback.stop();
                updatePlaybackButtons();
            }
            updateVoiceModeButton();
        });
    }

    // ── Recorder controls ──────────────────────────────────────────────────

    const recordButton = document.getElementById('recordButton');
    const stopRecordButton = document.getElementById('stopRecordButton');
    const cancelRecordButton = document.getElementById('cancelRecordButton');
    const transcribeButton = document.getElementById('transcribeButton');
    const recordingIndicator = document.getElementById('recordingIndicator');
    const recorderError = document.getElementById('recorderError');
    const transcriptionStatus = document.getElementById('transcriptionStatus');

    function updateRecorderUI() {
        const s = recorder.state;
        if (recordButton) {
            recordButton.hidden = (s === 'recording');
            recordButton.disabled = (s === 'recording');
        }
        if (transcribeButton) {
            transcribeButton.hidden = (s !== 'stopped');
            transcribeButton.disabled = transcription.state === 'busy';
        }
        if (stopRecordButton) {
            stopRecordButton.hidden = (s !== 'recording');
        }
        if (cancelRecordButton) {
            cancelRecordButton.hidden = (s !== 'recording');
        }
        if (recordingIndicator) {
            recordingIndicator.hidden = (s !== 'recording');
        }
        if (recorderError) {
            if (s === 'error' && recorder.error) {
                recorderError.textContent = recorder.error;
                recorderError.hidden = false;
            } else {
                recorderError.hidden = true;
                recorderError.textContent = '';
            }
        }
    }

    const recorder = createRecorderController({
        onStateChange: (s) => {
            updateRecorderUI();
            if (s === 'stopped') {
                const voiceMode = getVoiceModeState(currentConversation ? currentConversation.id : '');
                if (voiceMode) {
                    voiceTurnTimer.start();
                    voiceTurnTimer.markRecordingEnd();
                }
            }
            if (s === 'idle' || s === 'error') {
                voiceTurnTimer.cancel();
            }
        },
    });
    const transcription = createTranscriptionController({
        getCsrfToken,
        onStateChange: () => {
            updateRecorderUI();
            updateTranscriptionStatus();
        },
    });

    function updateTranscriptionStatus() {
        if (!transcriptionStatus) return;
        if (transcription.state === 'busy') {
            transcriptionStatus.textContent = 'Transcribing…';
            transcriptionStatus.hidden = false;
        } else if (transcription.state === 'error') {
            transcriptionStatus.textContent = transcription.error;
            transcriptionStatus.hidden = false;
        } else {
            transcriptionStatus.textContent = '';
            transcriptionStatus.hidden = true;
        }
    }

    if (typeof MediaRecorder === 'undefined' && recordButton) {
        recordButton.disabled = true;
        recordButton.title = 'Recording not supported in this browser';
    }

    if (recordButton) {
        recordButton.addEventListener('click', async () => {
            recordingInterruptionPending = true;
            playback.stop();
            updatePlaybackButtons();
            try {
                await recorder.start();
            } finally {
                recordingInterruptionPending = false;
                updateRecorderUI();
            }
        });
    }

    if (stopRecordButton) {
        stopRecordButton.addEventListener('click', () => {
            recorder.stop();
        });
    }

    if (cancelRecordButton) {
        cancelRecordButton.addEventListener('click', () => {
            recorder.cancel();
        });
    }

    if (transcribeButton) {
        transcribeButton.addEventListener('click', async () => {
            const blob = recorder.blob;
            updateTranscriptionStatus();
            const text = await transcription.transcribe(blob);
            if (text) {
                voiceTurnTimer.markSttComplete();
                const voiceMode = getVoiceModeState(currentConversation ? currentConversation.id : '');
                if (shouldAutoSendTranscription({ voiceModeEnabled: voiceMode, transcriptionSucceeded: true })) {
                    messageInput.value = text;
                    await sendMessage();
                } else {
                    messageInput.value = text;
                    messageInput.focus();
                    if (isDev) voiceTurnTimer.log();
                    voiceTurnTimer.cancel();
                }
            } else {
                if (isDev) voiceTurnTimer.log();
                voiceTurnTimer.cancel();
            }
            recorder.discard();
            updateRecorderUI();
            updateTranscriptionStatus();
        });
    }

    // ── Initial load ───────────────────────────────────────────────────────

    async function init() {
        try {
            await Promise.all([fetchCharacters(), fetchConversations(), fetchTtsVoices()]);
            renderCharacters();
            renderConversations();
            updateChatHeader();
        } catch (e) {
            renderState(conversationList, 'error', 'Failed to load data.');
            renderState(characterList, 'error', 'Failed to load data.');
        }

        const status = await fetchModelStatus();
        renderModelStatus(status);

        const health = await fetchHealthStatus();
        renderHealthStatus(health);

        const prereq = await fetchDeferredPrerequisite();
        renderPrerequisiteStatus(prereq);
    }

    init();
}
