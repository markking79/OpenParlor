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
    };
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

    let characters = [];
    let conversations = [];
    let currentConversation = null;
    let currentMessages = [];
    let isSending = false;

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
            messageEl.appendChild(content);
            messagesEl.appendChild(messageEl);
        }

        scrollMessages();
    }

    function updateChatHeader() {
        if (!currentConversation) {
            chatTitle.textContent = 'OpenParlor';
            chatSubtitle.textContent = 'Select a conversation to begin';
            messageInput.disabled = true;
            sendButton.disabled = true;
            return;
        }
        const char = characters.find(c => c.id === currentConversation.characterId);
        chatTitle.textContent = currentConversation.title;
        chatSubtitle.textContent = char ? char.name : '';
        messageInput.disabled = false;
        sendButton.disabled = false;
    }

    function scrollMessages() {
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    // ── API helpers ────────────────────────────────────────────────────────

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

    // ── Actions ────────────────────────────────────────────────────────────

    async function selectConversation(id) {
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

            function processNewRecords() {
                for (let i = processedCount; i < parser.records.length; i++) {
                    const record = parser.records[i];
                    if (record.type === 'delta') {
                        assistantMsg.content += record.text;
                        if (lastBubble) lastBubble.textContent = assistantMsg.content;
                        scrollMessages();
                    } else if (record.type === 'error') {
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

    // ── Initial load ───────────────────────────────────────────────────────

    async function init() {
        try {
            await Promise.all([fetchCharacters(), fetchConversations()]);
            renderCharacters();
            renderConversations();
            updateChatHeader();
        } catch (e) {
            renderState(conversationList, 'error', 'Failed to load data.');
            renderState(characterList, 'error', 'Failed to load data.');
        }
    }

    init();
}
