// Banner.js — shows a record as a message-tray banner through the public
// tray API (the same calls network@cinnamon.org and menu@cinnamon.org use):
// a notificationDaemon.Source per (app, pid) and a MessageTray.Notification
// built exactly as the stock daemon builds it (icon, image, buttons,
// urgency, resident, transient). The banner is only the announcement; the
// record in History is the truth. Shell-only (imports.ui); exercised by
// the live check.
//
//   const banner = new Banner({
//       onDismiss: record => …,        // user closed the banner with its ×
//       onClick:   record => …,        // user clicked the banner body
//       onAction:  (record, key) => …, // user pressed an action button
//       onDropped: record => …,        // the tray destroyed it unshown (DND race)
//   });
//   banner.show(record)        // new banner (or updates one still alive for record.id)
//   banner.discard(id)         // Hush-initiated destroy: no callbacks, no NotificationClosed
//   banner.discardAll()
//   banner.ownsNotification(n) // for the tray's notify-applet-update
//   banner.count               // banners alive right now
//   banner.destroy()

const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;
const NotificationDaemon = imports.ui.notificationDaemon;
const St = imports.gi.St;

const Parse = require('./modules/Parse');

const WIRE_TO_TRAY = [MessageTray.Urgency.LOW, MessageTray.Urgency.NORMAL, MessageTray.Urgency.CRITICAL];

// Same rules as notificationDaemon.js _iconForNotificationData.
function iconFor(appIcon, hints, size) {
    const cache = St.TextureCache.get_default();
    if (appIcon) {
        if (appIcon.startsWith('file://')) return cache.load_uri_async(appIcon, size, size);
        return new St.Icon({ icon_name: appIcon, icon_type: St.IconType.SYMBOLIC, icon_size: size });
    }
    const data = hints && hints['image-data'];
    if (Array.isArray(data) && data.length === 7) {
        const [width, height, rowStride, hasAlpha, , , bytes] = data;
        try { return cache.load_from_raw(bytes, hasAlpha, width, height, rowStride, size); } catch (e) { /* fall through */ }
    }
    const path = hints && hints['image-path'];
    if (typeof path === 'string' && path) {
        if (path.startsWith('file://')) return cache.load_uri_async(path, size, size);
        return new St.Icon({ icon_name: path, icon_type: St.IconType.FULLCOLOR, icon_size: size });
    }
    const stock = (hints && hints.urgency === Parse.Urgency.CRITICAL) ? 'xsi-dialog-error-symbolic' : 'xsi-dialog-information-symbolic';
    return new St.Icon({ icon_name: stock, icon_type: St.IconType.SYMBOLIC, icon_size: size });
}

function imageFor(record, size) {
    const hints = record.hints || {};
    const appIcon = record.appIcon;
    if (!appIcon) return null;
    const data = hints['image-data'];
    if (Array.isArray(data) && data.length === 7) {
        const [width, height, rowStride, hasAlpha, , , bytes] = data;
        try { return St.TextureCache.get_default().load_from_raw(bytes, hasAlpha, width, height, rowStride, size); } catch (e) { return null; }
    }
    const path = hints['image-path'];
    if (typeof path === 'string' && path && path !== appIcon) {
        if (path.startsWith('file://')) return St.TextureCache.get_default().load_uri_async(path, size, size);
        return new St.Icon({ icon_name: path, icon_type: St.IconType.FULLCOLOR, icon_size: size });
    }
    return null;
}

class Banner {
    constructor(callbacks) {
        const c = callbacks || {};
        this._onDismiss = c.onDismiss || (() => {});
        this._onClick = c.onClick || (() => {});
        this._onAction = c.onAction || (() => {});
        this._onDropped = c.onDropped || (() => {});
        this._handles = new Map();     // record id → { record, notification, source, hushInitiated }
        this._sources = new Map();     // 'title|pid' → Source (persistent ones only)
        this._destroyed = false;
    }

    get count() { return this._handles.size; }

    ownsNotification(notification) {
        for (const h of this._handles.values()) if (h.notification === notification) return h.record.id;
        return null;
    }

    _sourceFor(record) {
        const key = record.appName + '|' + (record.pid | 0);
        if (!record.transient) {
            const existing = this._sources.get(key);
            if (existing) return existing;
        }
        const source = new NotificationDaemon.Source(record.appName || 'Unknown', record.pid | 0, record.sender || null, record.desktopEntry || null, null);
        source.setTransient(!!record.transient);
        source._hushSource = true;
        if (!record.transient) {
            this._sources.set(key, source);
            source.connect('destroy', () => { if (this._sources.get(key) === source) this._sources.delete(key); });
        }
        if (Main.messageTray) Main.messageTray.add(source);
        return source;
    }

    show(record) {
        if (this._destroyed || !record) return false;
        const hints = record.hints || {};
        const existing = this._handles.get(record.id);
        let handle;
        try {
            if (existing && !existing.notification._destroyed) {
                handle = existing;
                handle.record = record;
                handle.notification.update(record.summary, record.body,
                    { icon: iconFor(record.appIcon, hints, handle.source.ICON_SIZE), bodyMarkup: true, silent: !!record.suppressSound });
            } else {
                const source = this._sourceFor(record);
                const notification = new MessageTray.Notification(source, record.summary, record.body,
                    { icon: iconFor(record.appIcon, hints, source.ICON_SIZE), bodyMarkup: true, silent: !!record.suppressSound });
                handle = { record, notification, source, hushInitiated: false };
                this._handles.set(record.id, handle);
                notification.connect('clicked', () => { if (!handle.hushInitiated) this._onClick(handle.record); });
                notification.connect('action-invoked', (n, key) => { if (!handle.hushInitiated) this._onAction(handle.record, key); });
                notification.connect('destroy', (n, reason) => this._onDestroyed(handle, reason));
            }
            const n = handle.notification;
            n.setImage(imageFor(record, n.IMAGE_SIZE));
            n.clearButtons();
            if (record.actions.length) {
                n.setUseActionIcons(!!record.actionIcons);
                for (const a of record.actions) if (a.key !== 'default') n.addButton(a.key, a.label);
            }
            n.setUrgency(WIRE_TO_TRAY[record.urgency] !== undefined ? WIRE_TO_TRAY[record.urgency] : MessageTray.Urgency.NORMAL);
            n.setResident(!!record.resident);
            n.setTransient(!!record.transient);
            const sourceIcon = handle.source.useNotificationIcon ? iconFor(record.appIcon, hints, handle.source.ICON_SIZE) : null;
            handle.source.processNotification(n, sourceIcon);
            return true;
        } catch (e) {
            global.logError('[hush] banner failed for "' + record.summary + '": ' + e.message);
            if (handle) this.discard(record.id);
            return false;
        }
    }

    // reason: a number from NotificationDestroyedReason when the tray or a
    // caller passed one; the close button passes its St.Button; a source
    // going away or a click/action path passes nothing.
    _onDestroyed(handle, reason) {
        if (this._handles.get(handle.record.id) === handle) this._handles.delete(handle.record.id);
        if (handle.hushInitiated || this._destroyed) return;
        if (typeof reason === 'number') {
            if (reason === MessageTray.NotificationDestroyedReason.DISMISSED) this._onDropped(handle.record);
            return;
        }
        if (reason === undefined || reason === null) return;   // source vanished, or after click/action
        this._onDismiss(handle.record);
    }

    discard(id, reason) {
        const handle = this._handles.get(id);
        if (!handle) return false;
        handle.hushInitiated = true;
        this._handles.delete(id);
        try { handle.notification.destroy(reason); } catch (e) { /* already gone */ }
        return true;
    }

    discardAll(reason) {
        const ids = Array.from(this._handles.keys());
        for (const id of ids) this.discard(id, reason);
        return ids.length;
    }

    destroy() {
        if (this._destroyed) return;
        this.discardAll(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
        this._destroyed = true;
        for (const source of Array.from(this._sources.values())) {
            try { source.destroy(); } catch (e) { /* already gone */ }
        }
        this._sources.clear();
    }
}
