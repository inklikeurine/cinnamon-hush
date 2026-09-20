// Intake.js — Hush's implementation of org.freedesktop.Notifications.
//
// Cinnamon's C core owns the bus name; the JS daemon only exports a handler
// object on /org/freedesktop/Notifications (Main.notificationDaemon._dbusImpl).
// install() unexports that handler and exports this one on the same path;
// uninstall() reverses it exactly. Nothing else of the stock daemon is
// touched (proposal §6, notes/system-services.md §8.1).
//
// This module is pure Gio/GLib so it runs — and is tested — under plain
// `cjs`: intake.test.js exports it on a private path with a fake stock
// handler and drives it over the real session bus.
//
//   const intake = new Intake({ stockImpl, serverInfo: ['Hush', 'inklikeurine', version, '1.2'] });
//   intake.connect('notification', (i, record, isUpdate) => …);  // parsed, pid resolved; decide + show
//   intake.connect('closed', (i, record, reason) => …);          // NotificationClosed was emitted
//   intake.connect('sender-gone', (i, sender) => …);             // the client left the bus
//   intake.install()  → true, or false with intake.error set (nothing was changed)
//   intake.close(id, Parse.ClosedReason.DISMISSED)   // user dismissed a record → signal to the client
//   intake.invokeAction(id, 'default')               // → ActionInvoked
//   intake.setExpiry({ defaultTimeoutSec, removeOld })
//   intake.uninstall(); intake.destroy();
//
// Ids start at a random base in [1e6, 2e6) so that a client closing an id
// the stock daemon issued before the swap cannot hit a Hush record.

const GLib = imports.gi.GLib;
const Gio  = imports.gi.Gio;
const Signals = imports.signals;

const Parse = require('./modules/Parse');

var PATH = '/org/freedesktop/Notifications';

const IFACE_XML = '<node>\
<interface name="org.freedesktop.Notifications">\
<method name="Notify">\
<arg type="s" direction="in"/><arg type="u" direction="in"/><arg type="s" direction="in"/>\
<arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="as" direction="in"/>\
<arg type="a{sv}" direction="in"/><arg type="i" direction="in"/><arg type="u" direction="out"/>\
</method>\
<method name="CloseNotification"><arg type="u" direction="in"/></method>\
<method name="GetCapabilities"><arg type="as" direction="out"/></method>\
<method name="GetServerInformation">\
<arg type="s" direction="out"/><arg type="s" direction="out"/><arg type="s" direction="out"/><arg type="s" direction="out"/>\
</method>\
<signal name="NotificationClosed"><arg type="u"/><arg type="u"/></signal>\
<signal name="ActionInvoked"><arg type="u"/><arg type="s"/></signal>\
</interface></node>';

// Same list the stock daemon advertises (notificationDaemon.js GetCapabilities).
var CAPABILITIES = Object.freeze(['actions', 'action-icons', 'body', 'body-markup', 'icon-static', 'persistence', 'sound']);

function _log(level, msg) {
    const g = globalThis.global;
    if (g && typeof g[level] === 'function') g[level]('[hush] ' + msg);
}

class Intake {
    constructor(opts) {
        const o = opts || {};
        this._stock = o.stockImpl || null;
        this._bus = o.bus || Gio.DBus.session;
        this._path = o.path || PATH;
        this._serverInfo = Array.isArray(o.serverInfo) && o.serverInfo.length === 4
            ? o.serverInfo.map(String) : ['Hush', 'inklikeurine', '0.0.0', '1.2'];
        this.defaultTimeoutSec = Number.isFinite(o.defaultTimeoutSec) ? o.defaultTimeoutSec : 1800;
        this.removeOld = o.removeOld !== false;
        this._nextId = Number.isFinite(o.idBase) && o.idBase > 0 ? Math.floor(o.idBase) : 1000000 + Math.floor(Math.random() * 1000000);

        this._records = new Map();      // id → record, open at the protocol level
        this._senderPid = new Map();    // sender → pid (0 = unknown)
        this._senderWatch = new Map();  // sender → bus watch id
        this._pending = new Map();      // sender → [fn] waiting for the pid lookup
        this._expiring = [];            // records with expires > 0, soonest first
        this._expireTimer = 0;
        this._destroyed = false;

        this.installed = false;
        this.error = null;

        const handlers = {
            NotifyAsync: (params, invocation) => this._onNotify(params, invocation),
            CloseNotification: id => this._onCloseNotification(id),
            GetCapabilities: () => CAPABILITIES.slice(),
            GetServerInformation: () => this._serverInfo.slice()
        };
        this._impl = Gio.DBusExportedObject.wrapJSObject(IFACE_XML, handlers);
    }

    get count() { return this._records.size; }

    get nextId() { return this._nextId; }

    records() { return Array.from(this._records.values()); }

    get(id) { return this._records.get(id) || null; }

    // ── install / uninstall ───────────────────────────────────────────────

    install() {
        if (this.installed) return true;
        this.error = null;
        const stock = this._stock;
        if (!stock || typeof stock.unexport !== 'function' || typeof stock.export !== 'function') {
            this.error = 'stock notification handler not found';
            return false;
        }
        try {
            stock.unexport();
        } catch (e) {
            this.error = 'could not unexport the stock handler: ' + e.message;
            return false;
        }
        try {
            this._impl.export(this._bus, this._path);
        } catch (e) {
            this.error = 'could not export: ' + e.message;
            try { stock.export(this._bus, this._path); } catch (e2) { _log('logError', 'restore after failed export also failed: ' + e2.message); }
            return false;
        }
        this.installed = true;
        return true;
    }

    // Reverse of install(). Never throws; every step runs even if one fails.
    uninstall() {
        if (!this.installed) return;
        this.installed = false;
        try { this._impl.unexport(); } catch (e) { _log('logError', 'unexport failed: ' + e.message); }
        if (this._stock) {
            try { this._stock.export(this._bus, this._path); } catch (e) { _log('logError', 'could not restore the stock handler: ' + e.message); }
        }
    }

    destroy() {
        this._destroyed = true;
        this.uninstall();
        this._stopExpire();
        for (const id of this._senderWatch.values()) {
            try { Gio.bus_unwatch_name(id); } catch (e) { /* already gone */ }
        }
        this._senderWatch.clear();
        this._senderPid.clear();
        this._pending.clear();
        this._records.clear();
        this._expiring = [];
    }

    // ── DBus method handlers ──────────────────────────────────────────────

    _onNotify(params, invocation) {
        let sender = '';
        try { sender = invocation.get_sender() || ''; } catch (e) { sender = ''; }
        const now = Date.now();
        let record;
        try {
            record = Parse.parse(params, { id: 0, now, sender, defaultTimeoutSec: this.defaultTimeoutSec });
        } catch (e) {
            // Never lose a notification to a parser bug: fall back to a plain record.
            _log('logError', 'Notify parse failed, using a plain record: ' + e.message);
            try {
                record = Parse.parse([String(params[0] || ''), 0, '', String(params[3] || ''), '', [], {}, -1],
                    { id: 0, now, sender, defaultTimeoutSec: this.defaultTimeoutSec });
            } catch (e2) {
                try { invocation.return_dbus_error('org.freedesktop.Notifications.Error', String(e2.message)); } catch (e3) { /* gone */ }
                return;
            }
        }

        const replaced = record.replacesId ? this._records.get(record.replacesId) : null;
        if (replaced) {
            record.id = replaced.id;
            record.updates = (replaced.updates | 0) + 1;
            record.pid = replaced.pid;
            record.appId = replaced.appId;
            record.appLabel = replaced.appLabel;
            record.state = replaced.state;
            this._forgetExpiry(replaced);
        } else {
            record.replacesId = 0;
            record.id = this._nextId++;
            if (this._nextId > 0xFFFFFFFF) this._nextId = 1000000;
        }
        this._records.set(record.id, record);
        if (record.expires) this._armExpiry(record);

        try { invocation.return_value(GLib.Variant.new('(u)', [record.id])); } catch (e) { _log('logError', 'Notify reply failed: ' + e.message); }

        this._withPid(sender, pid => {
            if (this._destroyed) return;
            if (this._records.get(record.id) !== record) return;   // replaced or closed meanwhile
            record.pid = pid;
            this.emit('notification', record, !!replaced);
        });
    }

    _onCloseNotification(id) {
        this.close(id, Parse.ClosedReason.APP_CLOSED);
    }

    // ── protocol-level lifecycle ──────────────────────────────────────────

    close(id, reason) {
        const record = this._records.get(id);
        if (!record) return false;
        this._records.delete(id);
        this._forgetExpiry(record);
        record.closed = true;
        record.closedReason = Number.isFinite(reason) ? reason : Parse.ClosedReason.UNDEFINED;
        this._emitSignal('NotificationClosed', GLib.Variant.new('(uu)', [record.id, record.closedReason]));
        this.emit('closed', record, record.closedReason);
        return true;
    }

    // Closes every open record, the way a daemon going away would (reason
    // APP_CLOSED, spec §6 restore checklist step 1). Returns how many.
    closeAll(reason) {
        const ids = Array.from(this._records.keys());
        for (const id of ids) this.close(id, Number.isFinite(reason) ? reason : Parse.ClosedReason.APP_CLOSED);
        return ids.length;
    }

    invokeAction(id, key) {
        const record = this._records.get(id);
        if (!record) return false;
        this._emitSignal('ActionInvoked', GLib.Variant.new('(us)', [record.id, String(key)]));
        return true;
    }

    _emitSignal(name, variant) {
        if (!this.installed) return;
        try { this._impl.emit_signal(name, variant); } catch (e) { _log('logWarning', name + ' not sent: ' + e.message); }
    }

    // ── expiry (org.cinnamon.desktop.notifications remove-old / timeout) ──

    setExpiry(opts) {
        const o = opts || {};
        if (Number.isFinite(o.defaultTimeoutSec)) this.defaultTimeoutSec = o.defaultTimeoutSec;
        if (typeof o.removeOld === 'boolean') this.removeOld = o.removeOld;
        this._restartExpire();
    }

    _armExpiry(record) {
        let i = this._expiring.length;
        while (i > 0 && this._expiring[i - 1].expires > record.expires) i--;
        this._expiring.splice(i, 0, record);
        this._restartExpire();
    }

    _forgetExpiry(record) {
        const i = this._expiring.indexOf(record);
        if (i >= 0) { this._expiring.splice(i, 1); this._restartExpire(); }
    }

    _restartExpire() {
        this._stopExpire();
        if (!this.removeOld || this._expiring.length === 0 || this._destroyed) return;
        const ms = Math.max(1000, this._expiring[0].expires - Date.now());
        this._expireTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._expireTimer = 0;
            const rec = this._expiring[0];
            if (rec && rec.expires <= Date.now() + 50) this.close(rec.id, Parse.ClosedReason.EXPIRED);
            else this._restartExpire();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopExpire() {
        if (this._expireTimer) { GLib.source_remove(this._expireTimer); this._expireTimer = 0; }
    }

    // ── sender → pid, with name watching ──────────────────────────────────

    _withPid(sender, fn) {
        if (!sender) { fn(0); return; }
        if (this._senderPid.has(sender)) { fn(this._senderPid.get(sender)); return; }
        const queue = this._pending.get(sender);
        if (queue) { queue.push(fn); return; }
        this._pending.set(sender, [fn]);
        this._watchSender(sender);
        this._bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'GetConnectionUnixProcessID', GLib.Variant.new('(s)', [sender]), null,
            Gio.DBusCallFlags.NONE, 5000, null, (conn, res) => {
                let pid = 0;
                try { [pid] = conn.call_finish(res).deep_unpack(); } catch (e) { pid = 0; }
                if (this._destroyed) return;
                // Cache only while the sender is still watched (the watch goes with the name).
                if (this._senderWatch.has(sender)) this._senderPid.set(sender, pid | 0);
                const fns = this._pending.get(sender) || [];
                this._pending.delete(sender);
                for (const f of fns) { try { f(pid | 0); } catch (e) { _log('logError', 'notification handler threw: ' + e.message); } }
            });
    }

    _watchSender(sender) {
        if (this._senderWatch.has(sender)) return;
        let id = 0;
        try {
            id = Gio.bus_watch_name_on_connection(this._bus, sender, Gio.BusNameWatcherFlags.NONE, null,
                () => this._onSenderVanished(sender));
        } catch (e) {
            return;
        }
        this._senderWatch.set(sender, id);
    }

    _onSenderVanished(sender) {
        const id = this._senderWatch.get(sender);
        if (id) { try { Gio.bus_unwatch_name(id); } catch (e) { /* ignore */ } }
        this._senderWatch.delete(sender);
        this._senderPid.delete(sender);
        if (this._destroyed) return;
        for (const rec of this._records.values())
            if (rec.sender === sender) rec.senderGone = true;
        this.emit('sender-gone', sender);
    }
}
Signals.addSignalMethods(Intake.prototype);
