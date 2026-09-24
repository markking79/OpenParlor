import test from 'node:test';
import assert from 'node:assert/strict';
import { createSentenceSplitter } from '../../public/openparlor/audio.js';

// The think markers are built by concatenation so the literal marker text
// never appears in this source file.
const THINK_OPEN = '<' + 'think>';
const THINK_CLOSE = '</' + 'think>';

/**
 * Feeds the full text in fixed-size chunks and collects every sentence
 * emitted, including the finish flush.
 * @param {string} text
 * @param {number} chunkSize
 * @returns {string[]}
 */
function splitAll(text, chunkSize) {
    const splitter = createSentenceSplitter();
    const sentences = [];
    for (let i = 0; i < text.length; i += chunkSize) {
        sentences.push(...splitter.feed(text.slice(i, i + chunkSize)));
    }
    sentences.push(...splitter.finish());
    return sentences;
}

/**
 * Reference one-shot transform: drops the same regions the splitter drops
 * (fenced code, think, analysis — earliest open wins, first close marker
 * wins, non-greedy) and joins the kept sides with one space when
 * non-whitespace characters touch. An unterminated region is dropped from
 * its open marker to the end, matching the splitter's finish behavior.
 * @param {string} text
 * @returns {string}
 */
function referenceSpeakable(text) {
    const blocks = [
        { open: '```', close: '```' },
        { open: THINK_OPEN, close: THINK_CLOSE },
        { open: '<analysis>', close: '</analysis>' },
    ];
    let out = '';
    let i = 0;
    while (i < text.length) {
        let best = null;
        for (const block of blocks) {
            const index = text.indexOf(block.open, i);
            if (index !== -1 && (best === null || index < best.index)) {
                best = { index: index, close: block.close, openLength: block.open.length };
            }
        }
        if (best === null) {
            out += text.slice(i);
            break;
        }
        const closeIndex = text.indexOf(best.close, best.index + best.openLength);
        out += text.slice(i, best.index);
        if (closeIndex === -1) {
            break;
        }
        const suffix = text.slice(closeIndex + best.close.length);
        if (out !== '' && suffix !== '') {
            const last = out.charAt(out.length - 1);
            const first = suffix.charAt(0);
            if (!/\s/.test(last) && !/\s/.test(first)) {
                out += ' ';
            }
        }
        i = closeIndex + best.close.length;
    }
    return out;
}

function stripWhitespace(value) {
    return value.replace(/\s+/g, '');
}

/**
 * Asserts the emitted sentences are exactly the speakable text of `text`
 * (same characters in the same order, ignoring whitespace), so no speakable
 * text is lost and no dropped-block text is emitted.
 * @param {string} text
 * @param {string[]} sentences
 */
function assertCoversSpeakable(text, sentences) {
    const expected = stripWhitespace(referenceSpeakable(text));
    const actual = stripWhitespace(sentences.join(''));
    assert.equal(actual, expected, `speakable mismatch: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

test('splits a simple sentence on a period', () => {
    const splitter = createSentenceSplitter();
    assert.deepEqual(splitter.feed('Hello world'), []);
    assert.deepEqual(splitter.feed('. How are you?'), ['Hello world.']);
    assert.deepEqual(splitter.finish(), ['How are you?']);
});

test('splits multiple sentences in one chunk', () => {
    const splitter = createSentenceSplitter();
    assert.deepEqual(splitter.feed('One. Two! Three?'), ['One.', 'Two!']);
    assert.deepEqual(splitter.finish(), ['Three?']);
});

test('feed returns nothing until a boundary is confirmed', () => {
    const splitter = createSentenceSplitter();
    assert.deepEqual(splitter.feed('A. B. C.'), ['A.', 'B.']);
    assert.deepEqual(splitter.finish(), ['C.']);
});

test('splits when a terminator is followed by whitespace only', () => {
    const splitter = createSentenceSplitter();
    assert.deepEqual(splitter.feed('Ends here.\tNext line'), ['Ends here.']);
    assert.deepEqual(splitter.finish(), ['Next line']);
});

test('treats terminator clusters as one boundary', () => {
    const splitter = createSentenceSplitter();
    assert.deepEqual(splitter.feed('No way?! Really?!! Then what.'), ['No way?!', 'Really?!!']);
    assert.deepEqual(splitter.finish(), ['Then what.']);
});

test('keeps a question mark and exclamation point together', () => {
    const splitter = createSentenceSplitter();
    assert.deepEqual(splitter.feed('What?!'), []);
    assert.deepEqual(splitter.feed(' Oh my.'), ['What?!']);
    assert.deepEqual(splitter.finish(), ['Oh my.']);
});

test('splits on an ellipsis followed by whitespace', () => {
    const splitter = createSentenceSplitter();
    assert.deepEqual(splitter.feed('Wait... what? Then.'), ['Wait...', 'what?']);
    assert.deepEqual(splitter.finish(), ['Then.']);
});

test('keeps a trailing ellipsis pending until confirmed', () => {
    const splitter = createSentenceSplitter();
    assert.deepEqual(splitter.feed('Wait...'), []);
    assert.deepEqual(splitter.feed(' More.'), ['Wait...']);
    assert.deepEqual(splitter.finish(), ['More.']);
});

test('does not split on a period inside a decimal', () => {
    const splitter = createSentenceSplitter();
    assert.deepEqual(splitter.feed('Pi is 3.14159. Next.'), ['Pi is 3.14159.']);
    assert.deepEqual(splitter.finish(), ['Next.']);
});

test('confirms a terminal period only on finish', () => {
    const splitter = createSentenceSplitter();
    assert.deepEqual(splitter.feed('Stop.'), []);
    assert.deepEqual(splitter.finish(), ['Stop.']);
});

test('a newline after an ASCII terminator confirms the split', () => {
    const splitter = createSentenceSplitter();
    assert.deepEqual(splitter.feed('Ends here.\nNext.'), ['Ends here.']);
    assert.deepEqual(splitter.finish(), ['Next.']);
});

test('does not split before an ASCII terminator at chunk end', () => {
    const splitter = createSentenceSplitter();
    assert.deepEqual(splitter.feed('Ends here.'), []);
    assert.deepEqual(splitter.feed(' Next.'), ['Ends here.']);
    assert.deepEqual(splitter.finish(), ['Next.']);
});

test('absorbs closing quotes into the sentence', () => {
    const splitter = createSentenceSplitter();
    assert.deepEqual(splitter.feed('He said "hi." Then left.'), ['He said "hi."']);
    assert.deepEqual(splitter.finish(), ['Then left.']);
});

test('absorbs parentheses and brackets after the terminator', () => {
    const splitter = createSentenceSplitter();
    assert.deepEqual(splitter.feed('Done (see above). Next [ok].'), ['Done (see above).']);
    assert.deepEqual(splitter.finish(), ['Next [ok].']);
});

test('does not split after protected abbreviations', () => {
    const singleSentences = [
        'Dr. Smith was late.',
        'Mr. and Mrs. Jones live here.',
        'Ms. Lee said yes.',
        'Mrs. Brown is home.',
        'Prof. Adams taught.',
        'Gen. Ford commanded.',
        'Capt. Reed reported.',
        'Sgt. Hill replied.',
        'St. Louis is big.',
        'Jr. and Sr. met.',
        'No. 5 is my favorite.',
        'approx. 10 came.',
        'i.e. this means that.',
        'e.g. like this one.',
        'vs. the other side.',
        'Inc. filed the report.',
        'Ltd. closed early.',
        'Co. shipped it.',
        'U.S. roads are long.',
        'U.K. trains were fast.',
        'a.m. meetings are quiet.',
        'p.m. meetings are boring.',
        'etc. came last.',
    ];
    for (const sentence of singleSentences) {
        const splitter = createSentenceSplitter();
        assert.deepEqual(splitter.feed(sentence), [], `unexpected early split for: ${sentence}`);
        assert.deepEqual(splitter.finish(), [sentence], `full sentence expected for: ${sentence}`);
    }
});

test('still splits at a real boundary after an abbreviation', () => {
    const splitter = createSentenceSplitter();
    assert.deepEqual(splitter.feed('Dr. Smith left. We stayed.'), ['Dr. Smith left.']);
    assert.deepEqual(splitter.finish(), ['We stayed.']);
});

test('splits when an abbreviation is followed by an emphasis cluster', () => {
    const splitter = createSentenceSplitter();
    assert.deepEqual(splitter.feed('It is U.S.! No doubt.'), ['It is U.S.!']);
    assert.deepEqual(splitter.finish(), ['No doubt.']);
});

test('keeps an abbreviation and its following sentence together', () => {
    const splitter = createSentenceSplitter();
    assert.deepEqual(splitter.feed('He met Mr. Smith at 5 p.m. They talked.'), []);
    assert.deepEqual(splitter.finish(), ['He met Mr. Smith at 5 p.m. They talked.']);
});

test('protects an abbreviation split across chunks', () => {
    const splitter = createSentenceSplitter();
    assert.deepEqual(splitter.feed('The CEO said Mr'), []);
    assert.deepEqual(splitter.feed('. Smith left.'), []);
    assert.deepEqual(splitter.finish(), ['The CEO said Mr. Smith left.']);
});

test('keeps an abbreviation pending when its period arrives late', () => {
    const splitter = createSentenceSplitter();
    assert.deepEqual(splitter.feed('Call Dr'), []);
    assert.deepEqual(splitter.feed('. Wang at 9 a.m.'), []);
    assert.deepEqual(splitter.finish(), ['Call Dr. Wang at 9 a.m.']);
});

test('drops fenced code split across chunks', () => {
    const splitter = createSentenceSplitter();
    assert.deepEqual(splitter.feed('Before\n```js\nconst x = 1;'), ['Before']);
    assert.deepEqual(splitter.feed('```\nAfter.'), []);
    assert.deepEqual(splitter.finish(), ['After.']);
});

test('drops think blocks split across chunks', () => {
    const splitter = createSentenceSplitter();
    assert.deepEqual(splitter.feed('A\n' + THINK_OPEN + 'let me think'), ['A']);
    assert.deepEqual(splitter.feed(THINK_CLOSE + 'B.'), []);
    assert.deepEqual(splitter.finish(), ['B.']);
});

test('drops analysis blocks split across chunks', () => {
    const splitter = createSentenceSplitter();
    assert.deepEqual(splitter.feed('Start<analysis>deep\nanalysis here'), []);
    assert.deepEqual(splitter.feed('</analysis>End.'), []);
    assert.deepEqual(splitter.finish(), ['Start End.']);
});

test('never emits text inside fenced code even if it looks like sentences', () => {
    const splitter = createSentenceSplitter();
    const out = [
        ...splitter.feed('Run\n```\nconsole.log("Hello. World?");\n```\nnow.'),
        ...splitter.finish(),
    ];
    assert.deepEqual(out, ['Run', 'now.']);
});

test('treats the earliest opened block as the active one', () => {
    const splitter = createSentenceSplitter();
    const out = [...splitter.feed('A\n```\nB\n```\nC.'), ...splitter.finish()];
    assert.deepEqual(out, ['A', 'C.']);
});

test('uses the first closing marker like transformForSpeech', () => {
    const splitter = createSentenceSplitter();
    const out = [...splitter.feed('A```B```C```D'), ...splitter.finish()];
    assert.deepEqual(out, ['A C']);
});

test('accumulates partial block markers before treating them as blocks', () => {
    const splitter = createSentenceSplitter();
    assert.deepEqual(splitter.feed('Hello\nle'), ['Hello']);
    assert.deepEqual(splitter.feed('t me'), []);
    assert.deepEqual(splitter.feed('<thi'), []);
    assert.deepEqual(splitter.feed('nk>'), []);
    assert.deepEqual(splitter.finish(), ['let me']);
});

test('keeps marker-like text that is never a complete marker', () => {
    const splitter = createSentenceSplitter();
    assert.deepEqual(splitter.feed('Use <th for this. Done.'), ['Use <th for this.']);
    assert.deepEqual(splitter.finish(), ['Done.']);
});

test('drops an unterminated fence at finish time', () => {
    const splitter = createSentenceSplitter();
    assert.deepEqual(splitter.feed('Done\n```js\npartial'), ['Done']);
    assert.deepEqual(splitter.finish(), []);
});

test('treats newlines as sentence boundaries', () => {
    const splitter = createSentenceSplitter();
    assert.deepEqual(splitter.feed('First line\nSecond line.'), ['First line']);
    assert.deepEqual(splitter.finish(), ['Second line.']);
});

test('skips empty paragraphs between sentences', () => {
    const splitter = createSentenceSplitter();
    assert.deepEqual(splitter.feed('One.\n\nTwo.'), ['One.']);
    assert.deepEqual(splitter.finish(), ['Two.']);
});

test('handles carriage-return line endings', () => {
    const splitter = createSentenceSplitter();
    assert.deepEqual(splitter.feed('A\r\nB.'), ['A']);
    assert.deepEqual(splitter.finish(), ['B.']);
});

test('splits CJK text on CJK terminators', () => {
    const splitter = createSentenceSplitter();
    assert.deepEqual(splitter.feed('你好。世界！'), ['你好。', '世界！']);
    assert.deepEqual(splitter.feed('再见？'), ['再见？']);
    assert.deepEqual(splitter.finish(), []);
});

test('absorbs a CJK closing quote after the terminator', () => {
    const splitter = createSentenceSplitter();
    const out = [...splitter.feed('他说："你好。"然后走了。'), ...splitter.finish()];
    assert.deepEqual(out, ['他说："你好。"', '然后走了。']);
});

test('splits CJK text even without spaces or ASCII terminators', () => {
    const out = splitAll('第一句。第二句！第三句？第四句。', 3);
    assert.deepEqual(out, ['第一句。', '第二句！', '第三句？', '第四句。']);
});

test('finish flushes the final sentence without a terminator', () => {
    const splitter = createSentenceSplitter();
    assert.deepEqual(splitter.feed('The end'), []);
    assert.deepEqual(splitter.finish(), ['The end']);
});

test('finish is idempotent', () => {
    const splitter = createSentenceSplitter();
    assert.deepEqual(splitter.feed('One. Two'), ['One.']);
    assert.deepEqual(splitter.finish(), ['Two']);
    assert.deepEqual(splitter.finish(), []);
});

test('finish after an unterminated block drops only the block content', () => {
    const splitter = createSentenceSplitter();
    assert.deepEqual(splitter.feed('Keep this.\n' + THINK_OPEN + 'drop this'), ['Keep this.']);
    assert.deepEqual(splitter.finish(), []);
});

test('non-string input is ignored', () => {
    const splitter = createSentenceSplitter();
    assert.deepEqual(splitter.feed(undefined), []);
    assert.deepEqual(splitter.feed(null), []);
    assert.deepEqual(splitter.feed('Done.'), []);
    assert.deepEqual(splitter.finish(), ['Done.']);
});

test('forces a break at 300 characters for very long text', () => {
    const text = 'a'.repeat(1000);
    const out = splitAll(text, 7);
    assert.equal(out.length, 4);
    assert.deepEqual(out, ['a'.repeat(300), 'a'.repeat(300), 'a'.repeat(300), 'a'.repeat(100)]);
});

test('prefers a whitespace boundary near 300 when one exists', () => {
    const text = 'word '.repeat(200);
    const out = splitAll(text, 9);
    assert.ok(out.length >= 4, `expected at least 4 pieces, got ${out.length}`);
    for (const sentence of out) {
        assert.match(sentence, /^word( word)*$/);
        assert.ok(sentence.length <= 300, `sentence too long: ${sentence.length}`);
    }
    assert.equal(out.join(' '), 'word '.repeat(200).trim());
});

test('survives a 300-character boundary that would split a surrogate pair', () => {
    const text = 'x'.repeat(350) + '𝕆' + 'y'.repeat(10);
    const out = splitAll(text, 11);
    assertCoversSpeakable(text, out);
    for (const sentence of out) {
        assert.ok(sentence.length <= 305, `sentence too long: ${sentence.length}`);
    }
});

test('forces a break even when only newlines separate long runs', () => {
    const text = 'x'.repeat(500) + '\n' + 'y'.repeat(500);
    const out = splitAll(text, 5);
    assertCoversSpeakable(text, out);
    for (const sentence of out) {
        assert.ok(sentence.length <= 305, `sentence too long: ${sentence.length}`);
    }
});

test('emits identical sentences no matter how the stream is chunked', () => {
    const texts = [
        'Hello world. How are you? I am fine.',
        'Mr. Smith said 3.5 is small. What?! Really...',
        'First line\nSecond line. Third paragraph.',
        'A\n' + THINK_OPEN + '\nB\nC' + THINK_CLOSE + '```code```D',
        THINK_OPEN + '\n' + THINK_CLOSE + 'D',
        '你好。世界！再见？好的。',
        'No. 5 is ready. The U.S. is large. See Fig. 3, e.g. this.',
        'b'.repeat(100) + ' ' + 'c'.repeat(299) + '.',
        'x'.repeat(400) + ' end.',
        'He said "hi." and <analysis>hidden</analysis>left.',
        'a'.repeat(350) + '𝕆' + 'b'.repeat(10),
    ];
    for (const text of texts) {
        const baseline = splitAll(text, Math.max(1, text.length));
        for (const chunkSize of [1, 2, 3, 7, 31]) {
            assert.deepEqual(
                splitAll(text, chunkSize),
                baseline,
                `chunking changed output for chunkSize=${chunkSize} on: ${JSON.stringify(text.slice(0, 40))}`,
            );
        }
    }
});

test('emits every speakable character exactly once', () => {
    const texts = [
        'Hello world. How are you?',
        'Mr. Smith said 3.5 is small. What?! Really...',
        'A\n' + THINK_OPEN + '\nB\nC' + THINK_CLOSE + '```code```D',
        'One. Two! Three?\nFour. Mr. Smith said 3.5.',
        '你好。世界！再见？好的。',
        'He said "hi." and <analysis>hidden</analysis>left.',
        'b'.repeat(100) + ' ' + 'c'.repeat(299) + '.',
    ];
    for (const text of texts) {
        assertCoversSpeakable(text, splitAll(text, 7));
        assertCoversSpeakable(text, splitAll(text, 1));
        assertCoversSpeakable(text, splitAll(text, Math.max(1, text.length)));
    }
});

test('never emits a sentence longer than 305 characters', () => {
    const texts = [
        'a'.repeat(1000),
        'word '.repeat(200),
        'x'.repeat(500) + '\n' + 'y'.repeat(500),
        '𝕆'.repeat(400),
    ];
    for (const text of texts) {
        for (const chunkSize of [1, 7, 64]) {
            for (const sentence of splitAll(text, chunkSize)) {
                assert.ok(sentence.length <= 305, `sentence too long: ${sentence.length}`);
            }
        }
    }
});
