// Markup.js: body-markup sanitiser for Pango labels.
imports.searchPath.unshift(ARGV[1]);
const T = imports.lib;
const require = T.makeRequire(ARGV[0]);
const Markup = require('./modules/Markup');

T.run('allowed tags pass through', () => {
    T.eq(Markup.sanitise('<b>bold</b> <i>it</i> <u>u</u>'), '<b>bold</b> <i>it</i> <u>u</u>', 'b/i/u');
});

T.run('other tags are escaped, links unwrapped, images dropped', () => {
    T.eq(Markup.sanitise('<span size="large">x</span>'), '&lt;span size="large"&gt;x&lt;/span&gt;', 'span escaped');
    T.eq(Markup.sanitise('see <a href="https://example.invalid/p">this page</a>'), 'see this page', 'link text kept');
    T.eq(Markup.sanitise('pic <img src="x.png" alt="a"/> here'), 'pic  here', 'img dropped');
});

T.run('ampersands: bare ones escaped, the five spec entities preserved', () => {
    T.eq(Markup.sanitise('A & B &amp; C &lt; D &gt; E &quot; F &apos; G'), 'A &amp; B &amp; C &lt; D &gt; E &quot; F &apos; G', 'entities');
    T.eq(Markup.sanitise('&copy;'), '&amp;copy;', 'unknown entity escaped');
});

T.run('invalid markup falls back to fully escaped text', () => {
    const out = Markup.sanitise('<b>unclosed');
    T.eq(out, '&lt;b&gt;unclosed', 'escaped fallback');
});

T.run('empty and non-string input', () => {
    T.eq(Markup.sanitise(''), '', 'empty');
    T.eq(Markup.sanitise(null), '', 'null');
    T.eq(Markup.sanitise(undefined), '', 'undefined');
});

T.run('plain() strips tags and decodes entities', () => {
    T.eq(Markup.plain('<b>bold</b> &amp; <i>x</i> &lt;y&gt;'), 'bold & x <y>', 'plain');
});

T.run('summary() folds whitespace and truncates with an ellipsis', () => {
    T.eq(Markup.summary('  line one\n\nline   two  ', 80), 'line one line two', 'folded');
    T.eq(Markup.summary('abcdefghij', 5), 'abcd…', 'truncated');
    T.eq(Markup.summary('<b>abc</b>', 10), 'abc', 'tags stripped');
});

T.run('clipBody: short bodies keep markup, long ones are cut by lines/chars without markup', () => {
    T.eq(Markup.clipBody('<b>hi</b> & bye', { maxLines: 4, maxChars: 240 }), '<b>hi</b> &amp; bye', 'short keeps markup');
    T.eq(Markup.clipBody('', {}), '', 'empty');
    const five = 'one\ntwo\nthree\nfour\nfive';
    T.eq(Markup.clipBody(five, { maxLines: 4, maxChars: 240 }), 'one\ntwo\nthree\nfour…', 'cut to four lines');
    const long = 'x'.repeat(300);
    const out = Markup.clipBody(long, { maxLines: 4, maxChars: 240 });
    T.eq(out.length, 240, '239 chars + ellipsis');
    T.ok(out.endsWith('…'), 'ellipsis');
    T.eq(Markup.clipBody('<b>' + 'y'.repeat(300) + '</b> & z', { maxChars: 50 }).includes('<b>'), false, 'markup dropped when cut');
    T.eq(Markup.clipBody('a &amp; b\r\nc', { maxLines: 1 }), 'a &amp; b…', 'entities re-escaped after decoding; CRLF handled');
    T.eq(Markup.clipBody('one\ntwo', {}), 'one\ntwo', 'defaults');
});

T.exit();
