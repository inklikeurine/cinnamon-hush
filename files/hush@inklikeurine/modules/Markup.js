// Markup.js — sanitises the `body` of a notification for a Pango label.
// The freedesktop spec allows <b>, <i>, <u>, <a href="…"> and <img>; the
// message tray renders only b/i/u and escapes the rest. The drawer does the
// same, but turns <a href="…">text</a> into plain text (the link colour
// would suggest something clickable that is not) and drops <img> tags
// entirely. Invalid markup falls back to fully escaped text, validated
// with Pango.parse_markup when Pango is available. Pure; headless-tested.
//
//   Markup.sanitise('Hi <b>there</b> & <a href="x">link</a>')  → 'Hi <b>there</b> &amp; link'
//   Markup.plain('<b>bold</b> &amp; text')                       → 'bold & text'
//   Markup.clipBody(body, { maxLines: 4, maxChars: 240 })      → markup for a drawer row
//
// Why clipBody exists: a wrapping St.Label inside a scrollable St.BoxLayout
// must not ellipsize — with ellipsize on, its *minimum* height is a few
// pixels and Cinnamon's box lays scrolled content out at minimum heights,
// so rows collapse onto each other (2026-09-19). The body is therefore
// wrapped without ellipsis and long text is cut here instead.

let Pango = null;
try { Pango = imports.gi.Pango; } catch (e) { Pango = null; }

function _validate(markup) {
    if (!Pango) return true;
    try {
        Pango.parse_markup(markup, -1, '');
        return true;
    } catch (e) {
        return false;
    }
}

function escape(text) {
    return String(text === undefined || text === null ? '' : text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function sanitise(text) {
    let s = String(text === undefined || text === null ? '' : text);
    if (s === '') return '';

    // Links and images: keep a link's text, drop images.
    s = s.replace(/<a\b[^>]*>/gi, '').replace(/<\/a\s*>/gi, '');
    s = s.replace(/<img\b[^>]*\/?>/gi, '').replace(/<\/img\s*>/gi, '');

    // Escape '&' unless it already starts one of the five entities the spec allows.
    s = s.replace(/&(?!(amp|quot|apos|lt|gt);)/g, '&amp;');
    // Escape every '<' that is not one of the allowed tags.
    s = s.replace(/<(?!\/?[biu]>)/g, '&lt;');
    // Any '>' that is not closing an allowed tag is content.
    s = s.replace(/(<\/?[biu])?>/g, (m, tag) => (tag ? m : '&gt;'));

    if (_validate(s)) return s;
    return escape(text);
}

// The text a user would read: tags removed, entities decoded. For counts,
// tooltips and the panel label.
function plain(text) {
    let s = String(text === undefined || text === null ? '' : text);
    s = s.replace(/<[^>]*>/g, '');
    return s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

// First `max` characters of the readable text, with an ellipsis, newlines folded.
function summary(text, max) {
    const s = plain(text).replace(/\s+/g, ' ').trim();
    const n = Number.isFinite(max) && max > 0 ? max : 80;
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// Markup for a drawer row's body: full sanitised markup when the text is
// short enough, otherwise the readable text cut to `maxLines` lines and
// `maxChars` characters with an ellipsis (markup is dropped in that case —
// cutting inside tags is not worth the risk). Never returns invalid markup.
function clipBody(text, opts) {
    const o = opts || {};
    const maxLines = Number.isFinite(o.maxLines) && o.maxLines > 0 ? o.maxLines : 4;
    const maxChars = Number.isFinite(o.maxChars) && o.maxChars > 0 ? o.maxChars : 240;
    const raw = String(text === undefined || text === null ? '' : text);
    if (raw === '') return '';
    const readable = plain(raw).replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
    const lines = readable.split('\n');
    if (readable.length <= maxChars && lines.length <= maxLines) return sanitise(raw);
    let kept = lines.slice(0, maxLines).join('\n');
    if (kept.length > maxChars) kept = kept.slice(0, maxChars - 1).replace(/\s+$/, '');
    return escape(kept) + '…';
}
