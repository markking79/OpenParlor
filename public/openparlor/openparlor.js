// ─── Pure helpers (exported for Node.js tests) ───────────────────────────────

export function formatRelativeTime(isoString) {
    if (!isoString) return '';
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return '';

    const now = Date.now();
    const diffMs = now - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);

    if (diffSec < 10) return 'just now';
    if (diffSec < 60) return diffSec + 's ago';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return diffMin + 'm ago';
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return diffHr + 'h ago';
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return diffDay + 'd ago';
    return date.toLocaleDateString();
}

export function normalizeConversation(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
        id: typeof raw.id === 'string' ? raw.id : String(raw.id || ''),
        title: typeof raw.title === 'string' ? raw.title : 'Untitled',
        characterId: raw.character_id != null ? String(raw.character_id) : '',
        updatedAt: typeof raw.updated_at === 'string' ? raw.updated_at : '',
    };
}

export function normalizeCharacter(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
        id: typeof raw.id === 'string' ? raw.id : String(raw.id || ''),
        name: typeof raw.name === 'string' ? raw.name : 'Unknown',
        avatarUrl: typeof raw.avatar_url === 'string' ? raw.avatar_url : '',
        ttsVoice: typeof raw.tts_voice === 'string' ? raw.tts_voice : '',
    };
}

export function normalizeTtsVoices(raw) {
    if (!raw || typeof raw !== 'object') {
        return { voices: [], available: false };
    }
    return {
        voices: Array.isArray(raw.voices) ? raw.voices.filter(v => typeof v === 'string') : [],
        available: raw.available === true,
    };
}

export function normalizeAutoSpeakState(raw) {
    return raw === 'true' || raw === true;
}

/**
 * Pure decision helper: determines whether a completed assistant reply
 * should be auto-spoken. All conditions must be true.
 * @param {{
 *   sendConversationId: string,
 *   currentConversationId: string,
 *   sendEpoch: number,
 *   selectionEpoch: number,
 *   streamDone: boolean,
 *   hadStreamError: boolean,
 *   autoSpeakEnabled: boolean,
 *   hasContent: boolean,
 * }} params
 * @returns {boolean}
 */
export function shouldAutoSpeak({
    sendConversationId,
    currentConversationId,
    sendEpoch,
    selectionEpoch,
    streamDone,
    hadStreamError,
    autoSpeakEnabled,
    hasContent,
}) {
    return (
        sendConversationId !== '' &&
        sendConversationId === currentConversationId &&
        sendEpoch === selectionEpoch &&
        streamDone &&
        !hadStreamError &&
        autoSpeakEnabled &&
        hasContent
    );
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

export function mapChatRole(role) {
    if (role === 'character') return 'assistant';
    return role;
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

export function normalizeModelStatus(raw) {
    if (!raw || typeof raw !== 'object') {
        return { provider: '', model: '', endpointLabel: '', models: [], connected: false };
    }
    return {
        provider: typeof raw.provider === 'string' ? raw.provider : '',
        model: typeof raw.model === 'string' ? raw.model : '',
        endpointLabel: typeof raw.endpointLabel === 'string' ? raw.endpointLabel : '',
        models: Array.isArray(raw.models) ? raw.models.filter(m => typeof m === 'string') : [],
        connected: raw.connected === true,
    };
}

/**
 * Selects the first MIME type from candidates that the given
 * isTypeSupported predicate accepts. Returns '' if none are supported.
 * @param {string[]} candidates
 * @param {(mime: string) => boolean} isTypeSupported
 * @returns {string}
 */
export function selectSupportedMime(candidates, isTypeSupported) {
    for (const mime of candidates) {
        if (isTypeSupported(mime)) return mime;
    }
    return '';
}

/**
 * Creates a MediaRecorder controller for browser microphone recording.
 * All external dependencies are injectable for deterministic testing.
 * @param {{
 *   getUserMedia?: (constraints: object) => Promise<MediaStream>,
 *   MediaRecorderCtor?: { new (stream: MediaStream, options?: object): any, isTypeSupported: (mime: string) => boolean },
 *   maxDurationMs?: number,
 *   maxSizeBytes?: number,
 *   mimeCandidates?: string[],
 *   onStateChange?: (state: string) => void,
 * }} [deps]
 * @returns {{
 *   state: string,
 *   blob: Blob | null,
 *   error: string | null,
 *   start: () => Promise<void>,
 *   stop: () => void,
 *   cancel: () => void,
 * }}
 */
export function createRecorderController(deps = {}) {
    const {
        getUserMedia = (constraints) => navigator.mediaDevices.getUserMedia(constraints),
        MediaRecorderCtor = (typeof MediaRecorder !== 'undefined') ? MediaRecorder : null,
        maxDurationMs = 60000,
        maxSizeBytes = 5 * 1024 * 1024,
        mimeCandidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'],
        onStateChange = null,
    } = deps;

    let state = 'idle';
    let recorder = null;
    let stream = null;
    let chunks = [];
    let blob = null;
    let error = null;
    let durationTimer = null;
    let startTime = 0;
    let totalSize = 0;
    let _cancelled = false;
    let _selectedMime = '';

    function setState(newState) {
        state = newState;
        if (onStateChange) onStateChange(state);
    }

    function cleanup() {
        if (durationTimer) {
            clearInterval(durationTimer);
            durationTimer = null;
        }
        if (stream) {
            for (const track of stream.getTracks()) {
                track.stop();
            }
            stream = null;
        }
        recorder = null;
        chunks = [];
        totalSize = 0;
    }

    async function start() {
        if (state === 'recording') return;

        if (!MediaRecorderCtor) {
            setState('error');
            error = 'MediaRecorder not supported';
            return;
        }

        _selectedMime = selectSupportedMime(mimeCandidates, (m) => MediaRecorderCtor.isTypeSupported(m));

        try {
            stream = await getUserMedia({ audio: true });
        } catch (e) {
            setState('error');
            error = (e && e.name === 'NotAllowedError') ? 'Permission denied' : 'Microphone unavailable';
            return;
        }

        try {
            const options = _selectedMime ? { mimeType: _selectedMime } : {};
            recorder = new MediaRecorderCtor(stream, options);
        } catch (e) {
            cleanup();
            setState('error');
            error = 'Failed to create recorder';
            return;
        }

        chunks = [];
        totalSize = 0;
        blob = null;
        error = null;
        _cancelled = false;

        recorder.ondataavailable = (event) => {
            if (event.data && event.data.size > 0) {
                totalSize += event.data.size;
                if (totalSize > maxSizeBytes) {
                    if (recorder && recorder.state === 'recording') {
                        recorder.stop();
                    }
                    return;
                }
                chunks.push(event.data);
            }
        };

        recorder.onstop = () => {
            if (_cancelled) {
                _cancelled = false;
                blob = null;
                chunks = [];
                totalSize = 0;
                setState('idle');
            } else if (state === 'recording') {
                blob = new Blob(chunks, { type: _selectedMime || 'audio/webm' });
                setState('stopped');
            }
            cleanup();
        };

        setState('recording');
        startTime = Date.now();
        recorder.start(250);

        durationTimer = setInterval(() => {
            if (Date.now() - startTime >= maxDurationMs) {
                if (recorder && recorder.state === 'recording') {
                    recorder.stop();
                }
            }
        }, 100);
        // Node's test runner must not stay alive solely for this browser timer.
        if (typeof durationTimer.unref === 'function') durationTimer.unref();
    }

    function stop() {
        if (state !== 'recording') return;
        if (recorder && recorder.state === 'recording') {
            recorder.stop();
        }
    }

    function cancel() {
        if (state !== 'recording') return;
        _cancelled = true;
        if (recorder && recorder.state === 'recording') {
            recorder.stop();
        }
    }

    function discard() {
        blob = null;
        if (state === 'stopped') setState('idle');
    }

    return {
        get state() { return state; },
        get blob() { return blob; },
        get error() { return error; },
        start,
        stop,
        cancel,
        discard,
    };
}

/**
 * Submits one recorded Blob to the server-owned STT endpoint. The controller
 * deliberately has no send-chat dependency: successful text is returned for
 * the composer to review and edit.
 * @param {{ fetchFn?: typeof fetch, getCsrfToken?: () => Promise<string>, onStateChange?: (state: string) => void }} [deps]
 */
export function createTranscriptionController(deps = {}) {
    const { fetchFn = fetch, getCsrfToken, onStateChange = null } = deps;
    let state = 'idle';
    let error = '';

    function setState(next) {
        state = next;
        if (onStateChange) onStateChange(state);
    }

    async function transcribe(blob) {
        if (!(blob instanceof Blob) || blob.size === 0 || state === 'busy') return null;
        error = '';
        setState('busy');
        try {
            const form = new FormData();
            form.append('audio', blob, 'recording.webm');
            const token = getCsrfToken ? await getCsrfToken() : '';
            const response = await fetchFn('/api/openparlor/stt/transcribe', {
                method: 'POST',
                headers: token ? { 'X-CSRF-Token': token } : {},
                body: form,
            });
            const result = await response.json().catch(() => null);
            if (!response.ok || !result || typeof result.text !== 'string' || !result.text.trim()) throw new Error('failed');
            setState('ready');
            return result.text.trim();
        } catch {
            error = 'Transcription failed. Please try again.';
            setState('error');
            return null;
        }
    }

    return { get state() { return state; }, get error() { return error; }, transcribe };
}

/**
 * Creates a playback controller that manages audio synthesis and playback
 * for a single message at a time. All external dependencies are injectable
 * for deterministic testing.
 * @param {{
 *   fetchFn?: (url: string, options?: object) => Promise<Response>,
 *   createObjectURL?: (blob: Blob) => string,
 *   revokeObjectURL?: (url: string) => void,
 *   audioFactory?: (url: string) => { play: () => Promise<void>, pause: () => void, src: string }
 * }} [deps]
 * @returns {{
 *   play: (text: string, voice: string) => Promise<string>,
 *   stop: () => void,
 *   replay: (text: string, voice: string) => Promise<string>,
 *   isPlaying: boolean
 * }}
 */
export function createPlaybackController(deps = {}) {
    const {
        fetchFn = (url, opts) => fetch(url, opts),
        createObjectURL = (blob) => URL.createObjectURL(blob),
        revokeObjectURL = (url) => URL.revokeObjectURL(url),
        audioFactory = (url) => new Audio(url),
    } = deps;

    let currentAudio = null;
    let currentUrl = null;
    let _isPlaying = false;
    let generation = 0;

    function stop() {
        generation++;
        if (currentAudio) {
            currentAudio.pause();
            currentAudio.src = '';
            currentAudio = null;
        }
        if (currentUrl) {
            revokeObjectURL(currentUrl);
            currentUrl = null;
        }
        _isPlaying = false;
    }

    async function play(text, voice) {
        stop();
        const gen = generation;
        const res = await fetchFn('/api/openparlor/tts/synthesize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, voice }),
        });
        if (gen !== generation) return null;
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || 'Synthesis failed');
        }
        const blob = await res.blob();
        if (gen !== generation) return null;
        currentUrl = createObjectURL(blob);
        currentAudio = audioFactory(currentUrl);
        const audio = currentAudio;
        if (typeof audio.addEventListener === 'function') {
            audio.addEventListener('ended', () => {
                if (currentAudio === audio) stop();
            }, { once: true });
        }
        _isPlaying = true;
        try {
            await audio.play();
        } catch (error) {
            if (currentAudio === audio) stop();
            throw error;
        }
        return currentUrl;
    }

    function replay(text, voice) {
        return play(text, voice);
    }

    return {
        play,
        stop,
        replay,
        get isPlaying() { return _isPlaying; },
    };
}

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
    const charFormError = document.getElementById('charFormError');
    const charFormSave = document.getElementById('charFormSave');
    const charFormCancel = document.getElementById('charFormCancel');
    const charVoiceSelect = document.getElementById('charVoiceSelect');
    const newCharacterButton = document.getElementById('newCharacterButton');
    const modelStatusDot = document.getElementById('modelStatusDot');
    const modelStatusBody = document.getElementById('modelStatusBody');
    const autoSpeakButton = document.getElementById('autoSpeakButton');

    let characters = [];
    let conversations = [];
    let currentConversation = null;
    let currentMessages = [];
    let isSending = false;
    let editingCharacterId = null;
    let ttsVoices = { voices: [], available: false };
    const playback = createPlaybackController();
    let selectionEpoch = 0;

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
            const char = characters.find(c => c.id === conv.characterId);
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

            item.append(titleEl, metaEl);
            item.addEventListener('click', () => selectConversation(conv.id));
            conversationList.appendChild(item);
        }
    }

    function renderCharacters() {
        characterList.innerHTML = '';
        characterSelect.innerHTML = '<option value="">Select a character…</option>';

        if (characters.length === 0) {
            renderState(characterList, 'empty', 'No characters found.');
            newChatButton.disabled = true;
            characterSelect.disabled = true;
            return;
        }

        for (const char of characters) {
            // Sidebar card
            const card = document.createElement('div');
            card.className = 'character-card';
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

            card.append(avatar, info);
            card.addEventListener('click', () => showCharacterForm(char));
            characterList.appendChild(card);

            // Select option
            const opt = document.createElement('option');
            opt.value = char.id;
            opt.textContent = char.name;
            characterSelect.appendChild(opt);
        }

        characterSelect.disabled = false;
        newChatButton.disabled = false;
    }

    function showCharacterForm(character) {
        editingCharacterId = character ? character.id : null;
        charNameInput.value = character ? character.name : '';
        charAvatarInput.value = character ? character.avatarUrl : '';
        populateVoiceSelect(character ? character.ttsVoice : '');
        charFormError.hidden = true;
        charFormError.textContent = '';
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
        charVoiceSelect.value = '';
        charFormError.hidden = true;
        charFormError.textContent = '';
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

        const char = characters.find(c => c.id === currentConversation.characterId);
        const charName = char ? char.name : 'Assistant';

        for (const msg of currentMessages) {
            const isUser = msg.role === 'user';
            const messageEl = document.createElement('div');
            messageEl.className = 'message' + (isUser ? ' user-message' : '');

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
            speakerEl.textContent = isUser ? 'You' : charName;

            const bubble = document.createElement('div');
            bubble.className = 'bubble';
            bubble.textContent = msg.content;

            content.append(speakerEl, bubble);

            if (!isUser && msg.content) {
                const actions = document.createElement('div');
                actions.className = 'message-actions';

                const char = characters.find(c => c.id === currentConversation.characterId);
                const voice = char ? char.ttsVoice : '';

                const playBtn = document.createElement('button');
                playBtn.className = 'play-btn';
                playBtn.setAttribute('aria-label', 'Play message');
                playBtn.textContent = '▶';
                playBtn.addEventListener('click', async () => {
                    try {
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
                    playback.stop();
                    updatePlaybackButtons();
                });

                const replayBtn = document.createElement('button');
                replayBtn.className = 'replay-btn';
                replayBtn.setAttribute('aria-label', 'Replay message');
                replayBtn.textContent = '↺';
                replayBtn.addEventListener('click', async () => {
                    try {
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
            return;
        }
        const char = characters.find(c => c.id === currentConversation.characterId);
        chatTitle.textContent = currentConversation.title;
        chatSubtitle.textContent = char ? char.name : '';
        messageInput.disabled = false;
        sendButton.disabled = false;
        updateAutoSpeakButton();
    }

    function scrollMessages() {
        messagesEl.scrollTop = messagesEl.scrollHeight;
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
        const res = await fetch('/api/openparlor/characters');
        if (!res.ok) throw new Error('Failed to load characters');
        const data = await res.json();
        characters = (Array.isArray(data) ? data : []).map(normalizeCharacter).filter(Boolean);
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
            throw new Error(err.error || 'Failed to create conversation');
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
            throw new Error(err.error || 'Failed to create character');
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
            throw new Error(err.error || 'Failed to update character');
        }
        return normalizeCharacter(await res.json());
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
            let saved;
            if (editingCharacterId) {
                saved = await updateCharacter(editingCharacterId, sanitized.name, sanitized.avatarUrl, sanitized.ttsVoice);
                const idx = characters.findIndex(c => c.id === editingCharacterId);
                if (idx !== -1) characters[idx] = saved;
            } else {
                saved = await createCharacter(sanitized.name, sanitized.avatarUrl, sanitized.ttsVoice);
                characters.push(saved);
            }
            hideCharacterForm();
            renderCharacters();
        } catch (e) {
            showFormError(e.message || 'Something went wrong');
        } finally {
            charFormSave.disabled = false;
        }
    }

    async function selectConversation(id) {
        selectionEpoch++;
        playback.stop();
        try {
            renderState(messagesEl, 'loading', 'Loading…');
            await fetchConversation(id);
            renderConversations();
            renderMessages();
            updateChatHeader();
        } catch (e) {
            renderState(messagesEl, 'error', 'Failed to load conversation.');
        }
    }

    async function handleNewConversation() {
        const charId = characterSelect.value;
        if (!charId) return;

        const char = characters.find(c => c.id === charId);
        const title = char ? 'Chat with ' + char.name : 'New conversation';

        try {
            newChatButton.disabled = true;
            const conv = await createConversation(charId, title);
            conversations.unshift(conv);
            currentConversation = conv;
            currentMessages = [];
            renderConversations();
            renderMessages();
            updateChatHeader();
        } catch (e) {
            renderState(messagesEl, 'error', 'Failed to create conversation.');
        } finally {
            newChatButton.disabled = false;
        }
    }

    async function sendMessage() {
        const text = messageInput.value.trim();
        if (!text || isSending || !currentConversation) return;

        const sendConversationId = currentConversation.id;
        const sendEpoch = selectionEpoch;

        isSending = true;
        sendButton.disabled = true;
        messageInput.value = '';

        // Append user message locally
        currentMessages.push({ role: 'user', content: text });
        renderMessages();

        // Create assistant bubble placeholder
        const assistantMsg = { role: 'assistant', content: '' };
        currentMessages.push(assistantMsg);
        renderMessages();

        const lastBubble = messagesEl.querySelector('.message:last-child .bubble');

        try {
            const token = await getCsrfToken();
            const response = await fetch('/api/openparlor/chat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': token,
                },
                body: JSON.stringify({
                    messages: currentMessages.map(m => ({ role: mapChatRole(m.role), content: m.content })),
                    stream: true,
                    conversation_id: currentConversation.id,
                }),
            });

            if (!response.ok) {
                const err = await response.json().catch(() => ({ error: 'Request failed' }));
                assistantMsg.content = err.error || 'Request failed';
                if (lastBubble) lastBubble.textContent = assistantMsg.content;
                scrollMessages();
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
                    if (record.type === 'delta') {
                        assistantMsg.content += record.text;
                        if (lastBubble) lastBubble.textContent = assistantMsg.content;
                        scrollMessages();
                    } else if (record.type === 'error') {
                        hadStreamError = true;
                        assistantMsg.content += '\n' + (record.error || 'Stream error');
                        if (lastBubble) lastBubble.textContent = assistantMsg.content;
                        scrollMessages();
                    } else if (record.type === 'done') {
                        streamDone = true;
                        break;
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

            // Auto-speak: play completed reply if enabled and conversation unchanged
            if (
                shouldAutoSpeak({
                    sendConversationId,
                    currentConversationId: currentConversation ? currentConversation.id : '',
                    sendEpoch,
                    selectionEpoch,
                    streamDone,
                    hadStreamError,
                    autoSpeakEnabled: getAutoSpeakState(sendConversationId),
                    hasContent: !!assistantMsg.content,
                })
            ) {
                const char = characters.find(c => c.id === currentConversation.characterId);
                const voice = char ? char.ttsVoice : '';
                if (voice) {
                    playback.play(assistantMsg.content, voice).catch(() => {});
                    updatePlaybackButtons();
                }
            }
        } catch {
            assistantMsg.content = 'Connection error';
            if (lastBubble) lastBubble.textContent = assistantMsg.content;
            scrollMessages();
        } finally {
            isSending = false;
            sendButton.disabled = false;
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
                playback.stop();
                updatePlaybackButtons();
            }
            updateAutoSpeakButton();
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

    const recorder = createRecorderController({ onStateChange: updateRecorderUI });
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
            await recorder.start();
            updateRecorderUI();
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
                messageInput.value = text;
                messageInput.focus();
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
    }

    init();
}
