const messageInput = document.getElementById('messageInput');
const sendButton = document.getElementById('sendButton');

function sendDemoMessage() {
    const text = messageInput.value.trim();

    if (!text) {
        return;
    }

    const messages = document.querySelector('.messages');

    const message = document.createElement('div');
    message.className = 'message user-message';

    const content = document.createElement('div');
    content.className = 'message-content';

    const speaker = document.createElement('div');
    speaker.className = 'speaker';
    speaker.textContent = 'You';

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;

    content.append(speaker, bubble);
    message.append(content);
    messages.append(message);

    messageInput.value = '';
    messages.scrollTop = messages.scrollHeight;
}

sendButton.addEventListener('click', sendDemoMessage);

messageInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendDemoMessage();
    }
});
