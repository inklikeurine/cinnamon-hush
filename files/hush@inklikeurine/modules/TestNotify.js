// TestNotify.js — the "Test" page of the settings dialog: canned
// notifications sent through the session bus exactly as an application
// would send them (a real `Notify` call to org.freedesktop.Notifications),
// so they exercise Hush's intake, policy, banners and drawer end to end.
// Pure GLib/Gio; testnotify.test.js drives it against an Intake exported on
// a private path.
//
//   const sender = new TestNotify();                 // { bus, name, path } to redirect
//   TestNotify.PRESETS                               // name → { app, icon, summary, body, actions, hints, timeout }
//   await sender.send('critical')                    // → notification id (u32)
//   await sender.send('updating')                    // one id, updated in place a few times
//   sender.destroy()                                 // cancels pending updates
//
// Hints are typed the way libnotify types them: urgency 'y', booleans 'b',
// strings 's'; every call also carries the boolean hint x-hush-test.

const GLib = imports.gi.GLib;
const Gio  = imports.gi.Gio;

var BUS_NAME = 'org.freedesktop.Notifications';
var PATH = '/org/freedesktop/Notifications';
var IFACE = 'org.freedesktop.Notifications';

const APP = 'Hush Test';
const ICON = 'dialog-information';

var PRESETS = Object.freeze({
    normal: {
        app: APP, icon: ICON, summary: 'A normal notification',
        body: 'Default urgency and timeout. Shows a banner unless Do Not Disturb is on.',
        actions: [], hints: { urgency: 1 }, timeout: -1
    },
    low: {
        app: APP, icon: 'dialog-information', summary: 'A low-urgency notification',
        body: 'Urgency low. Same as normal for Hush; some apps use it for chatter.',
        actions: [], hints: { urgency: 0 }, timeout: -1
    },
    critical: {
        app: APP, icon: 'dialog-warning', summary: 'A critical notification',
        body: 'Urgency critical: never expires, and still shows a banner during Do Not Disturb when "Show critical notifications" is on.',
        actions: [], hints: { urgency: 2 }, timeout: 0
    },
    actions: {
        app: APP, icon: 'mail-unread', summary: 'A notification with actions',
        body: 'Click the entry (default action) or press a button. Hush answers the app with ActionInvoked and logs it.',
        actions: ['default', 'Open', 'reply', 'Reply', 'mark-read', 'Mark read'], hints: { urgency: 1 }, timeout: -1
    },
    markup: {
        app: APP, icon: ICON, summary: 'Body markup & entities',
        body: '<b>bold</b>, <i>italic</i>, <u>underline</u>, an &amp; ampersand, a <a href="https://example.invalid/">link</a> and a <span>span</span> that must show as text.',
        actions: [], hints: { urgency: 1 }, timeout: -1
    },
    transient: {
        app: APP, icon: 'audio-volume-medium', summary: 'A transient notification',
        body: 'Hint "transient": banner only. With "Do not keep transient notifications" on, it never enters the drawer.',
        actions: [], hints: { urgency: 1, transient: true }, timeout: 3000
    },
    silent: {
        app: APP, icon: ICON, summary: 'A silent notification',
        body: 'Hint "suppress-sound": the banner shows but no sound plays.',
        actions: [], hints: { urgency: 1, 'suppress-sound': true }, timeout: -1
    },
    image: {
        app: APP, icon: 'camera-photo', summary: 'A notification with an image',
        body: 'app_icon plus an image-path hint: the tray shows both the icon and a large image.',
        actions: [], hints: { urgency: 1, 'image-path': 'emblem-photos' }, timeout: -1
    },
    app: {
        app: 'System Settings', icon: '', summary: 'From a known application',
        body: 'Hint "desktop-entry": Hush resolves the app, its name and its icon for the group header.',
        actions: [], hints: { urgency: 1, 'desktop-entry': 'cinnamon-settings' }, timeout: -1
    },
    long: {
        app: APP, icon: ICON, summary: 'A very long notification body that keeps going to test how the title is cut',
        body: 'Line one of a long body.\nLine two says a little more.\nLine three is where most rows would stop.\nLine four should be cut off in the drawer with an ellipsis.\nLine five is never seen there.',
        actions: [], hints: { urgency: 1 }, timeout: -1
    },
    updating: {
        app: APP, icon: 'folder-download', summary: 'Downloading', body: '0% — hint "resident", updated in place four times',
        actions: ['cancel', 'Cancel'], hints: { urgency: 1, resident: true }, timeout: 0,
        updates: [
            { summary: 'Downloading', body: '25% — same id, replaces_id update' },
            { summary: 'Downloading', body: '50%' },
            { summary: 'Downloading', body: '75%' },
            { summary: 'Download finished', body: '100% — the entry stays until dismissed', actions: [] }
        ],
        updateDelayMs: 1200
    },
    burst: {
        app: 'Mail', icon: 'mail-unread', summary: '2 new messages', body: 'Alex: are we still on for Thursday?',
        actions: [], hints: { urgency: 1, category: 'email.arrived' }, timeout: -1,
        burst: [
            { app: 'Messenger', icon: 'user-available', summary: 'Robin', body: 'Call me when you are free', actions: ['default', 'Open', 'reply', 'Reply'] },
            { app: 'Mail', icon: 'mail-unread', summary: 'Weekly digest', body: '14 threads you follow had replies', hints: { urgency: 0 } },
            { app: 'Software Updater', icon: 'system-software-update', summary: '3 updates available', body: 'Security updates for the kernel and the browser' },
            { app: 'Messenger', icon: 'user-available', summary: 'Sam', body: 'invoice attached', actions: ['default', 'Open'] }
        ],
        burstDelayMs: 250
    }
});

function _hintVariant(key, value) {
    if (key === 'urgency') return GLib.Variant.new_byte(value | 0);
    if (typeof value === 'boolean') return GLib.Variant.new_boolean(value);
    if (typeof value === 'number') return GLib.Variant.new_int32(value | 0);
    return GLib.Variant.new_string(String(value));
}

// Every test notification carries x-hush-test so the applet can clear
// them without touching real ones.
function _hints(obj) {
    const out = { 'x-hush-test': GLib.Variant.new_boolean(true) };
    for (const k of Object.keys(obj || {})) out[k] = _hintVariant(k, obj[k]);
    return out;
}

// The (susssasa{sv}i) tuple for one preset-shaped object.
function tuple(spec, replacesId) {
    return [
        String(spec.app || APP), (replacesId | 0) >>> 0, String(spec.icon || ''),
        String(spec.summary || ''), String(spec.body || ''),
        Array.isArray(spec.actions) ? spec.actions.map(String) : [],
        spec.hints || {}, Number.isFinite(spec.timeout) ? spec.timeout | 0 : -1
    ];
}

class TestNotify {
    constructor(opts) {
        const o = opts || {};
        this._bus = o.bus || Gio.DBus.session;
        this._name = o.name || BUS_NAME;
        this._path = o.path || PATH;
        this._timers = new Set();
        this._destroyed = false;
    }

    names() { return Object.keys(PRESETS); }

    // One raw Notify call; resolves with the id the server returned.
    notify(spec, replacesId) {
        return new Promise((resolve, reject) => {
            if (this._destroyed) { reject(new Error('TestNotify destroyed')); return; }
            const [app, rid, icon, summary, body, actions, hints, timeout] = tuple(spec, replacesId);
            const params = new GLib.Variant('(susssasa{sv}i)', [app, rid, icon, summary, body, actions, _hints(hints), timeout]);
            this._bus.call(this._name, this._path, IFACE, 'Notify', params, null, Gio.DBusCallFlags.NONE, 5000, null, (c, res) => {
                try { resolve(c.call_finish(res).deep_unpack()[0]); } catch (e) { reject(e); }
            });
        });
    }

    _sleep(ms) {
        return new Promise(resolve => {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                this._timers.delete(id);
                resolve();
                return GLib.SOURCE_REMOVE;
            });
            this._timers.add(id);
        });
    }

    // Sends a preset by name. 'updating' resolves after its last update,
    // 'burst' after its last notification; both resolve with the first id.
    async send(name) {
        const preset = PRESETS[name];
        if (!preset) throw new Error('unknown test notification: ' + name);
        const first = await this.notify(preset, 0);
        if (Array.isArray(preset.updates)) {
            for (const step of preset.updates) {
                await this._sleep(preset.updateDelayMs || 1000);
                if (this._destroyed) break;
                await this.notify(Object.assign({}, preset, step), first);
            }
        }
        if (Array.isArray(preset.burst)) {
            for (const item of preset.burst) {
                await this._sleep(preset.burstDelayMs || 250);
                if (this._destroyed) break;
                await this.notify(Object.assign({ hints: { urgency: 1 }, timeout: -1 }, item), 0);
            }
        }
        return first;
    }

    destroy() {
        this._destroyed = true;
        for (const id of this._timers) GLib.source_remove(id);
        this._timers.clear();
    }
}
