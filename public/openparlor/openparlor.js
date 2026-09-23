// ─── OpenParlor frontend entry point ───────────────────────────────────────────
// STAB-007: responsibilities were split into per-domain ES modules. The pure
// helpers are re-exported here so existing import paths (tests, scripts) keep
// working; the browser application lives in app.js.

import './app.js';

export { formatRelativeTime, normalizeServiceError, resolveBrowserUrl } from './ui.js';
export { createNdjsonParser, createStreamMessageCollector, mapChatRole, normalizeConversation, normalizeParticipants, resolveMessageCharacterId } from './conversations.js';
export { buildCardExportFilename, normalizeCharacter, sanitizeCharacterInput, validateCharacterForm } from './characters.js';
export { normalizeMemory, normalizeMemorySource, validateMemoryForm } from './memory.js';
export { checkLocalReadiness, fetchDeferredPrerequisite, normalizeAudioReadiness, normalizeChatReadiness, normalizeDeferredPrerequisite, normalizeHealthStatus, normalizeModelStatus, normalizeSettings } from './settings.js';
export { createGroupPlaybackQueue, createPlaybackController, createRecorderController, createTranscriptionController, createVoiceTurnTimer, normalizeAutoSpeakState, normalizeTtsVoices, normalizeVoiceModeState, selectSupportedMime, shouldAutoSendTranscription, shouldAutoSpeak } from './audio.js';
