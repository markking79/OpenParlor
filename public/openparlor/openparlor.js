function createNdjsonParser() {
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

if (typeof document !== 'undefined') {
    const messageInput = document.getElementById('messageInput');
    const sendButton = document.getElementById('sendButton');
    const messages = document.querySelector('.messages');

    let isSending = false;

    function createBubble(speaker, text) {
        const message = document.createElement('div');
        message.className = speaker === 'You' ? 'message user-message' : 'message assistant-message';

        const content = document.createElement('div');
        content.className = 'message-content';

        const speakerEl = document.createElement('div');
        speakerEl.className = 'speaker';
        speakerEl.textContent = speaker;

        const bubble = document.createElement('div');
        bubble.className = 'bubble';
        bubble.textContent = text;

        content.append(speakerEl, bubble);
        message.append(content);
        messages.append(message);

        return bubble;
    }

    function scrollMessages() {
        messages.scrollTop = messages.scrollHeight;
    }

    async function sendMessage() {
        const text = messageInput.value.trim();

        if (!text || isSending) {
            return;
        }

        isSending = true;
        sendButton.disabled = true;

        createBubble('You', text);
        messageInput.value = '';
        scrollMessages();

        const assistantBubble = createBubble('Assistant', '');

        try {
            const csrfResponse = await fetch('/csrf-token');
            if (!csrfResponse.ok) {
                throw new Error('Unable to get CSRF token');
            }
            const { token: csrfToken } = await csrfResponse.json();
            if (typeof csrfToken !== 'string' || !csrfToken) {
                throw new Error('Unable to get CSRF token');
            }

            const response = await fetch('/api/openparlor/chat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': csrfToken,
                },
                body: JSON.stringify({
                    messages: [{ role: 'user', content: text }],
                    stream: true,
                }),
            });

            if (!response.ok) {
                const err = await response.json().catch(() => ({ error: 'Request failed' }));
                assistantBubble.textContent = err.error || 'Request failed';
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
                        assistantBubble.textContent += record.text;
                        scrollMessages();
                    } else if (record.type === 'error') {
                        assistantBubble.textContent += '\n' + (record.error || 'Stream error');
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
            assistantBubble.textContent = 'Connection error';
            scrollMessages();
        } finally {
            isSending = false;
            sendButton.disabled = false;
        }
    }

    sendButton.addEventListener('click', sendMessage);

    messageInput.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            sendMessage();
        }
    });
}
