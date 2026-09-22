import multer from 'multer';

const AVATAR_MAX_FIELD_SIZE = 500 * 1024 * 1024;
const OPENPARLOR_STT_TRANSCRIBE_PATH = '/api/openparlor/stt/transcribe';

/**
 * Builds the global avatar upload middleware.
 *
 * OpenParlor's STT endpoint parses its own multipart "audio" upload. If the avatar
 * parser ran first it would reject that field as an unexpected field and consume the
 * request stream before the STT router could handle it, so the avatar parser is
 * skipped for that route and every other request keeps the original behavior.
 * @param {string} uploadsPath Destination directory for uploaded avatar files
 * @returns {import('express').RequestHandler}
 */
export function createAvatarUploadMiddleware(uploadsPath) {
    const avatarUpload = multer({ dest: uploadsPath, limits: { fieldSize: AVATAR_MAX_FIELD_SIZE } }).single('avatar');
    return (request, response, next) => {
        if (request.path === OPENPARLOR_STT_TRANSCRIBE_PATH) {
            return next();
        }
        return avatarUpload(request, response, next);
    };
}
