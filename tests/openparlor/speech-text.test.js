import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { transformForSpeech } from '../../src/openparlor/speech-text.js';

describe('transformForSpeech', () => {
    describe('reasoning block removal', () => {
        it('removes a complete think block', () => {
            const input = 'Hello<think>internal reasoning</think>world';
            assert.equal(transformForSpeech(input), 'Hello world');
        });

        it('removes a complete analysis block', () => {
            const input = 'Start<analysis>deep analysis here</analysis>End';
            assert.equal(transformForSpeech(input), 'Start End');
        });

        it('removes multiple think blocks', () => {
            const input = 'A<think>one</think>B<think>two</think>C';
            assert.equal(transformForSpeech(input), 'A B C');
        });

        it('removes think block with multiline content', () => {
            const input = 'Before\n<think>\nline1\nline2\n</think>\nAfter';
            assert.equal(transformForSpeech(input), 'Before After');
        });

        it('preserves unclosed think tag', () => {
            const input = 'Hello <think>unclosed';
            assert.equal(transformForSpeech(input), 'Hello <think>unclosed');
        });

        it('preserves unclosed analysis tag', () => {
            const input = 'Hello <analysis>unclosed';
            assert.equal(transformForSpeech(input), 'Hello <analysis>unclosed');
        });
    });

    describe('fenced code block removal', () => {
        it('removes a fenced code block with language', () => {
            const input = 'Before\n```js\nconst x = 1;\n```\nAfter';
            assert.equal(transformForSpeech(input), 'Before After');
        });

        it('removes a fenced code block without language', () => {
            const input = 'Before\n```\nsome code\n```\nAfter';
            assert.equal(transformForSpeech(input), 'Before After');
        });

        it('removes multiple fenced code blocks', () => {
            const input = 'A\n```\ncode1\n```\nB\n```\ncode2\n```\nC';
            assert.equal(transformForSpeech(input), 'A B C');
        });

        it('preserves text when no closing fence exists', () => {
            const input = 'Before\n```js\nunclosed code';
            assert.equal(transformForSpeech(input), 'Before ```js unclosed code');
        });
    });

    describe('markdown image removal', () => {
        it('removes a markdown image', () => {
            const input = 'Hello ![a cat](https://example.com/cat.png) world';
            assert.equal(transformForSpeech(input), 'Hello world');
        });

        it('removes multiple markdown images', () => {
            const input = '![a](http://a.com/a.png) and ![b](http://b.com/b.png)';
            assert.equal(transformForSpeech(input), 'and');
        });

        it('removes image with empty alt text', () => {
            const input = 'Before ![](https://example.com/img.jpg) After';
            assert.equal(transformForSpeech(input), 'Before After');
        });

        it('preserves non-image markdown links', () => {
            const input = 'Check [this link](https://example.com) out';
            assert.equal(transformForSpeech(input), 'Check [this link](https://example.com) out');
        });
    });

    describe('inline code marker removal', () => {
        it('removes backticks but keeps content', () => {
            const input = 'Use `npm install` to install';
            assert.equal(transformForSpeech(input), 'Use npm install to install');
        });

        it('removes multiple inline code spans', () => {
            const input = 'Run `cmd1` then `cmd2`';
            assert.equal(transformForSpeech(input), 'Run cmd1 then cmd2');
        });

        it('handles inline code with spaces', () => {
            const input = 'The `hello world` function';
            assert.equal(transformForSpeech(input), 'The hello world function');
        });
    });

    describe('whitespace normalization', () => {
        it('collapses multiple spaces into one', () => {
            assert.equal(transformForSpeech('hello   world'), 'hello world');
        });

        it('collapses newlines into spaces', () => {
            assert.equal(transformForSpeech('hello\n\nworld'), 'hello world');
        });

        it('collapses tabs into spaces', () => {
            assert.equal(transformForSpeech('hello\t\tworld'), 'hello world');
        });

        it('trims leading and trailing whitespace', () => {
            assert.equal(transformForSpeech('  hello world  '), 'hello world');
        });
    });

    describe('empty and edge cases', () => {
        it('returns empty string for empty input', () => {
            assert.equal(transformForSpeech(''), '');
        });

        it('returns empty string when only think block remains', () => {
            assert.equal(transformForSpeech('<think>only reasoning</think>'), '');
        });

        it('returns empty string when only fenced code remains', () => {
            assert.equal(transformForSpeech('```\ncode\n```'), '');
        });

        it('returns empty string when only an image remains', () => {
            assert.equal(transformForSpeech('![img](http://a.com/a.png)'), '');
        });

        it('returns empty string for whitespace-only input', () => {
            assert.equal(transformForSpeech('   \n\t  '), '');
        });

        it('returns empty string for non-string input', () => {
            assert.equal(transformForSpeech(null), '');
            assert.equal(transformForSpeech(undefined), '');
            assert.equal(transformForSpeech(42), '');
        });
    });

    describe('combined transformations', () => {
        it('handles text with all removal types', () => {
            const input = [
                '<think>Let me think...</think>',
                'Here is the answer:',
                '```python',
                'print("hello")',
                '```',
                '![diagram](http://example.com/d.png)',
                'Use `pip install` to get started.',
                '<analysis>More reasoning</analysis>',
                'Done.',
            ].join('\n');
            assert.equal(transformForSpeech(input), 'Here is the answer: Use pip install to get started. Done.');
        });

        it('preserves ordinary prose unchanged', () => {
            const input = 'The quick brown fox jumps over the lazy dog.';
            assert.equal(transformForSpeech(input), 'The quick brown fox jumps over the lazy dog.');
        });
    });
});
