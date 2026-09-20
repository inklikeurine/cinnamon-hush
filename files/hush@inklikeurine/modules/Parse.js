// Parse.js — turns the argument tuple of an org.freedesktop.Notifications
// `Notify` call into a plain record, exactly as Cinnamon's own daemon
// normalises it (js/ui/notificationDaemon.js, NotifyAsync): hint aliases
// from spec 1.0/1.1, absolute icon paths to file:// URIs, XChat summary
// rewrites, urgency defaulting, expiry arithmetic. Pure GLib — runs
// headless under `cjs` and is covered by @local/tests/hush@inklikeurine/parse.test.js.
//
//   const Parse = require('./modules/Parse');
//   const rec = Parse.parse([appName, replacesId, appIcon, summary, body, actions, hints, timeout],
//                           { id: 42, now: Date.now(), sender: ':1.7', defaultTimeoutSec: 1800 });

const GLib = imports.gi.GLib;

// Wire urgency (spec): 0 low, 1 normal, 2 critical.
var Urgency = Object.freeze({ LOW: 0, NORMAL: 1, CRITICAL: 2 });

// NotificationClosed reasons (spec).
var ClosedReason = Object.freeze({ EXPIRED: 1, DISMISSED: 2, APP_CLOSED: 3, UNDEFINED: 4 });

// Cinnamon-specific summary rewrites, kept for parity with the stock daemon.
const rewriteRules = {
    'XChat': [
        { pattern: /^XChat: Private message from: (\S*) \(.*\)$/, replacement: '<$1>' },
        { pattern: /^XChat: New public message from: (\S*) \((.*)\)$/, replacement: '$2 <$1>' },
        { pattern: /^XChat: Highlighted message from: (\S*) \((.*)\)$/, replacement: '$2 <$1>' }
    ]
};

// Hints arrive as GLib.Variant values from the exported object; tests may
// pass plain values. Either way the result is a plain object.
function unpackHints(hints) {
    const out = {};
    if (!hints || typeof hints !== 'object') return out;
    for (const key of Object.keys(hints)) {
        const v = hints[key];
        out[key] = (v && typeof v.deep_unpack === 'function') ? v.deep_unpack() : v;
    }
    return out;
}

function _toUri(pathOrName) {
    if (typeof pathOrName !== 'string' || pathOrName === '') return pathOrName || '';
    if (GLib.path_is_absolute(pathOrName)) {
        try { return GLib.filename_to_uri(pathOrName, null); } catch (e) { return pathOrName; }
    }
    return pathOrName;
}

function _bool(v) {
    return v === true || v === 1;
}

// Expiry timestamp (ms since epoch) or 0 for "never", mirroring the stock
// daemon: a timeout of 0, a resident hint or critical urgency never expire;
// -1 means the org.cinnamon.desktop.notifications `timeout` default (seconds);
// anything else is milliseconds.
function computeExpires(timeout, hints, now, defaultTimeoutSec) {
    if (!timeout || _bool(hints.resident) || hints.urgency === Urgency.CRITICAL) return 0;
    if (timeout === -1) return now + Math.max(1, defaultTimeoutSec | 0) * 1000;
    return now + timeout;
}

function normaliseActions(actions) {
    const out = [];
    if (!Array.isArray(actions)) return out;
    for (let i = 0; i + 1 < actions.length; i += 2)
        out.push({ key: String(actions[i]), label: String(actions[i + 1]) });
    return out;
}

// params: the eight Notify arguments. opts: { id, now, sender, defaultTimeoutSec }.
function parse(params, opts) {
    const o = opts || {};
    let [appName, replacesId, appIcon, summary, body, actions, rawHints, timeout] = params;
    appName = typeof appName === 'string' ? appName : '';
    summary = typeof summary === 'string' ? summary : '';
    body = typeof body === 'string' ? body : '';
    appIcon = typeof appIcon === 'string' ? appIcon : '';
    timeout = Number.isFinite(timeout) ? timeout : -1;
    const now = Number.isFinite(o.now) ? o.now : Date.now();

    const hints = unpackHints(rawHints);

    const rewrites = rewriteRules[appName];
    if (rewrites) {
        for (const rule of rewrites)
            if (summary.search(rule.pattern) !== -1) summary = summary.replace(rule.pattern, rule.replacement);
    }

    let urgency = hints.urgency;
    if (typeof urgency !== 'number' || urgency < Urgency.LOW || urgency > Urgency.CRITICAL) urgency = Urgency.NORMAL;
    hints.urgency = urgency;

    // Spec 1.1 / early-spec aliases → the 1.2 names.
    if (!hints['image-path'] && hints['image_path']) hints['image-path'] = hints['image_path'];
    if (!hints['image-data']) {
        if (hints['image_data']) hints['image-data'] = hints['image_data'];
        else if (hints['icon_data'] && !hints['image-path']) hints['image-data'] = hints['icon_data'];
    }
    delete hints['image_path']; delete hints['image_data']; delete hints['icon_data'];

    appIcon = _toUri(appIcon);
    if (typeof hints['image-path'] === 'string') hints['image-path'] = _toUri(hints['image-path']);
    else delete hints['image-path'];

    hints['suppress-sound'] = _bool(hints['suppress-sound']);
    hints['transient'] = _bool(hints['transient']);
    hints['resident'] = _bool(hints['resident']);
    hints['action-icons'] = _bool(hints['action-icons']);

    const desktopEntry = typeof hints['desktop-entry'] === 'string' ? hints['desktop-entry'] : '';
    const category = typeof hints.category === 'string' ? hints.category : '';

    return {
        id: o.id | 0,
        replacesId: (typeof replacesId === 'number' && replacesId > 0) ? replacesId : 0,
        appName,
        appIcon,
        summary,
        body,
        actions: normaliseActions(actions),
        urgency,
        transient: hints['transient'],
        resident: hints['resident'],
        suppressSound: hints['suppress-sound'],
        actionIcons: hints['action-icons'],
        desktopEntry,
        category,
        imagePath: hints['image-path'] || '',
        hasImageData: Array.isArray(hints['image-data']) && hints['image-data'].length === 7,
        hints,
        timeout,
        expires: computeExpires(timeout, hints, now, o.defaultTimeoutSec),
        time: now,
        sender: typeof o.sender === 'string' ? o.sender : '',
        pid: 0,
        appId: '',
        appLabel: '',
        state: 'unread',
        missed: false,
        closed: false,
        closedReason: 0,
        senderGone: false,
        updates: 0
    };
}

// Drop the large hint payloads once the banner has consumed them; the
// history keeps only what a drawer row needs.
function stripHeavy(record) {
    if (record && record.hints) {
        delete record.hints['image-data'];
    }
    return record;
}
