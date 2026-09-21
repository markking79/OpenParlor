/**
 * Transforms raw text into a speech-friendly string for TTS synthesis.
 * Removes model-only reasoning blocks, Markdown image URLs, fenced-code blocks,
 * and inline code markers. Normalizes remaining whitespace.
 * Returns an empty string if no speakable text remains.
 * @param {string} text
 * @returns {string}
 */
export function transformForSpeech(text) {
    if (typeof text !== 'string') return '';

    let result = text;

    // Remove complete think blocks
    result = result.replace(/<think>[\s\S]*?<\/think>/g, ' ');

    // Remove complete analysis blocks
    result = result.replace(/<analysis>[\s\S]*?<\/analysis>/g, ' ');

    // Remove fenced code blocks (``` ... ```)
    result = result.replace(/```[\s\S]*?```/g, '');

    // Remove Markdown image URLs: ![alt](url)
    result = result.replace(/!\[[^\]]*\]\([^)]*\)/g, '');

    // Remove inline code markers (backticks) but keep the content
    result = result.replace(/`([^`]+)`/g, '$1');

    // Normalize whitespace: collapse runs of whitespace into a single space
    result = result.replace(/\s+/g, ' ').trim();

    return result;
}
