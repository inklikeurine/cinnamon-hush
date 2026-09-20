// applet.js — Hush: notification centre with Do Not Disturb and a sliding list.
//
// Hush replaces the intake of Cinnamon's notification daemon in-process
// (modules/Intake.js): every org.freedesktop.Notifications Notify call
// becomes a record in History, Policy decides whether the message tray shows
// a banner (modules/Banner.js), and the drawer (modules/Drawer.js) lists the
// records grouped by app. Removing or reloading the applet restores the stock
// daemon exactly (see on_applet_removed_from_panel, the restore checklist).
//
// Hush owns its Do Not Disturb state and never writes
// org.cinnamon.desktop.notifications display-notifications; that key being
// false is one more DND reason ("set in System Settings"). The other reasons
// are the user's switch, a schedule (modules/Schedule.js) and three
// automatic triggers: a fullscreen window (modules/Fullscreen.js), a call or
// recording in progress (modules/Recording.js, microphone streams) and a
// listed application holding a session inhibitor (modules/shared/Inhibitors.js).

const Applet    = imports.ui.applet;
const Settings  = imports.ui.settings;
const Main      = imports.ui.main;
const MessageTray = imports.ui.messageTray;
const Util      = imports.misc.util;
const GLib      = imports.gi.GLib;
const Gio       = imports.gi.Gio;
const St        = imports.gi.St;
const Cinnamon  = imports.gi.Cinnamon;
const Gettext   = imports.gettext;

// Local modules through Cinnamon's require(): re-evaluated on every reload.
const Parse    = require('./modules/Parse');
const AppId    = require('./modules/AppId');
const Policy   = require('./modules/Policy');
const HistoryModule = require('./modules/History');
const History  = HistoryModule.History;
const DndState = require('./modules/DndState').DndState;
const Intake   = require('./modules/Intake').Intake;
const Banner   = require('./modules/Banner').Banner;
const Drawer   = require('./modules/Drawer').Drawer;
const TestNotify = require('./modules/TestNotify').TestNotify;
const Schedule = require('./modules/Schedule');
const Fullscreen = require('./modules/Fullscreen').Fullscreen;
const Recording = require('./modules/Recording').Recording;
const Store = require('./modules/Store').Store;
const Dnd = require('./modules/shared/Dnd').Dnd;
const InhibitorsModule = require('./modules/shared/Inhibitors');
const Inhibitors = InhibitorsModule.Inhibitors;

const UUID = 'hush@inklikeurine';
const LOG_PREFIX = '[hush] ';
const ICON_NORMAL = 'preferences-system-notifications-symbolic';
const ICON_DND = 'notifications-disabled-symbolic';
const DATA_DIR = GLib.get_home_dir() + '/.local/share/hush';
const BLINK_MS = 700;

Gettext.bindtextdomain(UUID, GLib.get_home_dir() + '/.local/share/locale');
function _(str) {
    const translated = Gettext.dgettext(UUID, str);
    return translated !== str ? translated : window._(str);
}

class HushApplet extends Applet.TextIconApplet {

    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);

        this._metadata   = metadata;
        this._instanceId = instanceId;
        this._destroyed  = false;
        this._signals    = [];      // [obj, id] pairs to disconnect on removal
        this._trayHooked = false;

        this.setAllowedLayout(Applet.AllowedLayout.BOTH);
        this.set_applet_icon_symbolic_name(ICON_NORMAL);
        this.set_applet_tooltip(_('Hush'));
        this.hide_applet_label(true);

        // ── Settings ─────────────────────────────────────────────────────
        this._settings = new Settings.AppletSettings(this, UUID, instanceId);
        this._settings.bind('allow-critical', '_allowCritical');
        this._settings.bind('drawer-direction', '_drawerDirection', () => this._drawer && this._drawer.setDirection(this._drawerDirection));
        this._settings.bind('drawer-width', '_drawerWidth', () => this._drawer && this._drawer.setWidth(this._drawerWidth | 0));
        this._settings.bind('history-max', '_historyMax', () => { this._history.setMax(this._historyMax | 0); this._refresh(); });
        this._settings.bind('missed-clear-mode', '_missedClearMode');
        this._settings.bind('show-count', '_showCount', () => this._refresh());
        this._settings.bind('ignore-transient', '_ignoreTransient');
        this._settings.bind('persist-history', '_persistHistory', () => this._onPersistChanged());
        this._settings.bind('blink-on-new', '_blinkOnNew', () => this._updateBlink());
        this._settings.bind('muted-apps', '_mutedApps', () => this._refresh());
        this._settings.bind('key-open', '_keyOpen', () => this._setKeybindings());
        this._settings.bind('key-clear', '_keyClear', () => this._setKeybindings());
        this._settings.bind('key-dnd', '_keyDnd', () => this._setKeybindings());
        this._settings.bind('schedule-enabled', '_scheduleEnabled', () => this._reschedule(false));
        this._settings.bind('schedule-start', '_scheduleStart', () => this._reschedule(false));
        this._settings.bind('schedule-end', '_scheduleEnd', () => this._reschedule(false));
        this._settings.bind('schedule-days', '_scheduleDays', () => this._reschedule(false));
        this._settings.bind('auto-fullscreen', '_autoFullscreen', () => this._syncFullscreen());
        this._settings.bind('auto-fullscreen-scope', '_autoFullscreenScope', () => this._syncFullscreen());
        this._settings.bind('auto-recording', '_autoRecording', () => this._syncRecording());
        this._settings.bind('auto-inhibitor-apps', '_autoInhibitorApps', () => this._syncInhibitors());
        this._settings.bind('inhibitor-apps', '_inhibitorApps', () => this._syncInhibitors());

        // ── State ────────────────────────────────────────────────────────
        this._store = new Store({ dir: DATA_DIR });
        const state = this._store.loadState();
        if (this._persistHistory !== false) {
            this._history = History.fromJSON(this._store.loadHistory(), { max: this._historyMax | 0 || 100 });
            if (this._history.size) global.log(LOG_PREFIX + 'restored ' + this._history.size + ' notification(s) from ' + this._store.historyPath);
        } else {
            this._history = new History({ max: this._historyMax | 0 || 100 });
        }
        this._dnd = new DndState();
        this._showCleared = false;
        this._blinkTimer = 0;
        this._blinkDim = false;

        // The stock daemon's own settings feed expiry; the system-wide DND key
        // (shared Dnd.js) is the "external" reason.
        this._notifSettings = new Gio.Settings({ schema_id: 'org.cinnamon.desktop.notifications' });
        this._connect(this._notifSettings, 'changed::remove-old', () => this._syncExpiry());
        this._connect(this._notifSettings, 'changed::timeout', () => this._syncExpiry());
        this._dndKey = new Dnd();
        this._dndKey.onChanged(() => this._syncExternalDnd());

        // Schedule + automatic triggers.
        this._scheduleTimer = 0;
        this._fullscreen = new Fullscreen({ scope: this._autoFullscreenScope });
        this._fullscreen.onChanged(() => this._syncFullscreen());
        this._recording = new Recording({ name: 'hush' });
        this._recording.onChanged(() => this._syncRecording());
        this._inhibitors = null;
        Inhibitors.create().then(inh => {
            if (this._destroyed) { inh.destroy(); return; }
            this._inhibitors = inh;
            inh.onChanged(() => this._syncInhibitors());
            this._syncInhibitors();
        }, e => global.logWarning(LOG_PREFIX + 'session inhibitors unavailable: ' + e.message));
        this._testInhibit = null;

        // ── Banner + drawer ──────────────────────────────────────────────
        this._banner = new Banner({
            onDismiss: rec => this._userDismissed(rec),
            onClick:   rec => this._userActivated(rec),
            onAction:  (rec, key) => this._userAction(rec, key),
            onDropped: rec => { rec.missed = true; this._refresh(); }
        });

        this._drawer = new Drawer(this, {
            width: this._drawerWidth | 0 || 380,
            direction: this._drawerDirection || 'auto',
            gettext: _,
            iconFor: (rec, size) => this._iconFor(rec, size),
            onDndToggle: () => this._toggleManualDnd(),
            onDismiss: rec => this._userDismissed(rec),
            onAction: (rec, key) => this._userAction(rec, key),
            onActivate: rec => this._userActivated(rec),
            onClearAll: () => this._clearAll(),
            onHushSettings: () => { this._drawer.close(); this.configureApplet(); },
            onNotificationSettings: () => { this._drawer.close(); Util.spawnCommandLine('cinnamon-settings notifications'); },
            onOpened: () => { if (this._history.markSeen(this._missedClearMode) > 0) this._refresh(); },
            onMuteToggle: group => this._toggleMute(group),
            onToggleCleared: () => { this._showCleared = !this._showCleared; this._refresh(); },
            onDeleteCleared: () => { const n = this._history.deleteCleared(); global.log(LOG_PREFIX + 'deleted ' + n + ' cleared notification(s)'); this._refresh(); }
        });

        // ── Intake swap ──────────────────────────────────────────────────
        const daemon = Main.notificationDaemon;
        const stockImpl = daemon && daemon._dbusImpl ? daemon._dbusImpl : null;
        this._intake = new Intake({
            stockImpl,
            serverInfo: ['Hush', 'inklikeurine', String(metadata.version || '0.0.0'), '1.2'],
            defaultTimeoutSec: this._notifSettings.get_int('timeout'),
            removeOld: this._notifSettings.get_boolean('remove-old'),
            // Continue the id sequence across reloads so a fresh id can never
            // replace a restored record.
            idBase: Number.isFinite(state.nextId) && state.nextId > 0 ? state.nextId : undefined
        });
        this._connect(this._intake, 'notification', (i, rec, isUpdate) => this._onNotification(rec, isUpdate));
        this._connect(this._intake, 'closed', (i, rec, reason) => this._onClosed(rec, reason));
        this._connect(this._intake, 'sender-gone', () => this._refresh());

        if (this._intake.install()) {
            global.log(LOG_PREFIX + 'notification intake installed (stock handler parked)');
        } else {
            global.logWarning(LOG_PREFIX + 'notification capture unavailable: ' + this._intake.error + ' — running with the stock daemon; Do Not Disturb still works');
            this._drawer.setNotice(_('Notification capture is unavailable on this Cinnamon version. Notifications are handled by the built-in daemon; Do Not Disturb still works but nothing is collected.'));
        }

        // The tray hands every banner back after it hides (D10). Hush's own
        // banners are discarded (the record is the list); foreign transient
        // ones are expired as the tray would have without an applet.
        MessageTray.extensionsHandlingNotifications++;
        this._trayHooked = true;
        this._connect(Main.messageTray, 'notify-applet-update', (tray, notification) => this._onTrayHandedBack(notification));

        // Settings → Test page: canned notifications through the real bus.
        this._testNotify = new TestNotify();

        this._syncExternalDnd();
        this._syncFullscreen();
        this._syncRecording();
        this._reschedule(false);
        this._setKeybindings();
        this._refresh();
    }

    _connect(obj, signal, handler) {
        const id = obj.connect(signal, handler);
        this._signals.push([obj, id]);
        return id;
    }

    // ── Intake events ────────────────────────────────────────────────────

    _onNotification(record, isUpdate) {
        if (this._destroyed) return;
        try {
            const app = this._lookupApp(record);
            const ident = AppId.derive({
                desktopEntry: record.desktopEntry,
                resolvedDesktopId: app ? app.get_id() : '',
                resolvedName: app ? app.get_name() : '',
                appName: record.appName
            });
            record.appId = ident.id;
            record.appLabel = ident.label;
            record.test = !!(record.hints && record.hints['x-hush-test'] === true);

            const decision = Policy.decide(record, {
                dnd: this._dnd.active,
                trayEnabled: !this._dndKey.active,
                allowCritical: this._allowCritical !== false,
                muted: Policy.mutedFromList(this._mutedApps)
            });

            if (decision === Policy.Decision.DROP) {
                this._intake.close(record.id, Parse.ClosedReason.DISMISSED);
                return;
            }
            // An update to a record the user already cleared stays cleared;
            // anything else is new to the user again.
            if (record.state !== HistoryModule.State.CLEARED) record.state = HistoryModule.State.UNREAD;
            if (decision === Policy.Decision.BANNER) {
                record.missed = false;
                this._banner.show(record);
            } else {
                record.missed = true;
                if (isUpdate) this._banner.discard(record.id);
            }
            Parse.stripHeavy(record);
            if (this._ignoreTransient && record.transient) {
                if (isUpdate) this._history.remove(record.id);
            } else {
                this._history.add(record);
            }
        } catch (e) {
            global.logError(LOG_PREFIX + 'handling a notification failed: ' + e.message);
        }
        this._refresh();
    }

    // The client closed it, it expired, or Hush closed it: the record stays
    // in the drawer (that is what a history is for) with its actions greyed.
    _onClosed(record, reason) {
        if (this._destroyed) return;
        this._banner.discard(record.id, MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
        this._refresh();
    }

    _onTrayHandedBack(notification) {
        if (this._destroyed || !notification) return;
        const id = this._banner.ownsNotification(notification);
        if (id !== null) {
            this._banner.discard(id);
            return;
        }
        // Foreign (tray-API) notification: without any other list applet, do
        // what the tray would have done with no applet at all.
        if (notification.isTransient && MessageTray.extensionsHandlingNotifications <= 1) {
            try { notification.destroy(MessageTray.NotificationDestroyedReason.EXPIRED); } catch (e) { /* gone */ }
        }
    }

    // ── User actions (banner or drawer) ──────────────────────────────────

    _userDismissed(record) {
        if (this._destroyed) return;
        this._history.dismiss(record.id);
        this._banner.discard(record.id);
        this._intake.close(record.id, Parse.ClosedReason.DISMISSED);
        this._refresh();
    }

    _userAction(record, key) {
        if (this._destroyed) return;
        this._intake.invokeAction(record.id, key);
        this._history.markRead(record.id);
        if (!record.resident) {
            this._history.dismiss(record.id);
            this._banner.discard(record.id);
            this._intake.close(record.id, Parse.ClosedReason.DISMISSED);
        }
        this._refresh();
    }

    _userActivated(record) {
        if (this._destroyed) return;
        this._history.markRead(record.id);
        if (record.actions.some(a => a.key === 'default')) this._intake.invokeAction(record.id, 'default');
        this._activateApp(record);
        if (!record.resident) {
            this._history.dismiss(record.id);
            this._banner.discard(record.id);
            this._intake.close(record.id, Parse.ClosedReason.DISMISSED);
        }
        this._drawer.close();
        this._refresh();
    }

    _clearAll() {
        if (this._destroyed) return;
        for (const rec of this._history.visible()) {
            this._banner.discard(rec.id);
            this._intake.close(rec.id, Parse.ClosedReason.DISMISSED);
        }
        this._history.clearAll();
        this._refresh();
    }

    // The switch: on = manual; off = manual off and every automatic reason
    // that holds it right now is overridden until it ends (schedule: until
    // its next boundary). System Settings' own key cannot be undone here.
    _toggleManualDnd() {
        if (this._destroyed || !this._dnd.switchable) return;
        if (this._dnd.active) this._dnd.userOff();
        else this._dnd.userOn();
        this._logDnd('switch');
        this._refresh();
    }

    _logDnd(source) {
        global.log(LOG_PREFIX + 'Do Not Disturb ' + (this._dnd.active ? 'on' : 'off') +
            ' (' + (this._dnd.reason || source) + ')');
    }

    // ── Do Not Disturb sources ───────────────────────────────────────────

    _syncExternalDnd() {
        if (this._dnd.set('external', this._dndKey.active)) { this._logDnd('external'); this._refresh(); }
    }

    _syncFullscreen() {
        if (this._destroyed) return;
        this._fullscreen.setScope(this._autoFullscreenScope);
        const active = this._autoFullscreen !== false && this._fullscreen.active;
        if (this._dnd.set('fullscreen', active)) { this._logDnd('fullscreen'); this._refresh(); }
    }

    _syncRecording() {
        if (this._destroyed) return;
        const active = this._autoRecording !== false && this._recording.active;
        if (this._dnd.set('recording', active)) { this._logDnd('recording'); this._refresh(); }
    }

    _inhibitorAppIds() {
        const list = Array.isArray(this._inhibitorApps) ? this._inhibitorApps : [];
        return list.map(e => (e && typeof e.app === 'string') ? e.app.trim() : '').filter(Boolean);
    }

    _syncInhibitors() {
        if (this._destroyed) return;
        const entry = (this._autoInhibitorApps !== false && this._inhibitors) ? this._inhibitors.find(this._inhibitorAppIds()) : null;
        if (this._dnd.set('inhibitor', !!entry, entry ? { app: entry.appId } : null)) { this._logDnd('inhibitor'); this._refresh(); }
    }

    _scheduleConfig() {
        return Schedule.fromSettings(this._scheduleEnabled, this._scheduleStart, this._scheduleEnd, this._scheduleDays);
    }

    // Re-evaluates the schedule now and arms a timer for its next boundary.
    // fromTimer: a boundary just passed, so a user override of the schedule ends.
    _reschedule(fromTimer) {
        if (this._destroyed) return;
        if (this._scheduleTimer) { GLib.source_remove(this._scheduleTimer); this._scheduleTimer = 0; }
        const cfg = this._scheduleConfig();
        const now = new Date();
        let changed = false;
        if (fromTimer) changed = this._dnd.unsuppress('schedule') || changed;
        const active = Schedule.isActive(cfg, now);
        changed = this._dnd.set('schedule', active, active ? { until: Schedule.formatTime(cfg.end) } : null) || changed;
        const next = Schedule.nextBoundary(cfg, now);
        if (next) {
            const secs = Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 1000) + 1);
            this._scheduleTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, secs, () => {
                this._scheduleTimer = 0;
                this._reschedule(true);
                return GLib.SOURCE_REMOVE;
            });
        }
        if (changed) { this._logDnd('schedule'); this._refresh(); }
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    _syncExpiry() {
        this._intake.setExpiry({
            defaultTimeoutSec: this._notifSettings.get_int('timeout'),
            removeOld: this._notifSettings.get_boolean('remove-old')
        });
    }

    _lookupApp(record) {
        try {
            const appSystem = Cinnamon.AppSystem.get_default();
            if (record.desktopEntry) {
                const id = record.desktopEntry.endsWith('.desktop') ? record.desktopEntry : record.desktopEntry + '.desktop';
                let app = appSystem.lookup_app(id);
                if (!app && typeof appSystem.lookup_flatpak_app_id === 'function') app = appSystem.lookup_flatpak_app_id(record.desktopEntry);
                if (app) return app;
            }
            if (record.pid) {
                const app = Cinnamon.WindowTracker.get_default().get_app_from_pid(record.pid);
                if (app) return app;
            }
        } catch (e) {
            // identity is best effort
        }
        return null;
    }

    _iconFor(record, size) {
        const cache = St.TextureCache.get_default();
        if (record.appIcon) {
            if (record.appIcon.startsWith('file://')) return cache.load_uri_async(record.appIcon, size, size);
            return new St.Icon({ icon_name: record.appIcon, icon_type: St.IconType.FULLCOLOR, icon_size: size });
        }
        const app = this._lookupApp(record);
        if (app) {
            try { return app.create_icon_texture(size); } catch (e) { /* fall through */ }
        }
        if (record.imagePath) {
            if (record.imagePath.startsWith('file://')) return cache.load_uri_async(record.imagePath, size, size);
            return new St.Icon({ icon_name: record.imagePath, icon_type: St.IconType.FULLCOLOR, icon_size: size });
        }
        return new St.Icon({ icon_name: record.urgency === Parse.Urgency.CRITICAL ? 'dialog-error-symbolic' : 'dialog-information-symbolic', icon_type: St.IconType.SYMBOLIC, icon_size: size });
    }

    _activateApp(record) {
        const app = this._lookupApp(record);
        if (!app) return;
        try {
            const windows = app.get_windows();
            if (windows.length > 0) Main.activateWindow(windows[0]);
        } catch (e) {
            // no window to raise
        }
    }

    _refresh() {
        if (this._destroyed) return;
        const unread = this._history.unreadCount();
        this._drawer.setDnd({ active: this._dnd.active, label: this._dnd.label(_), switchable: this._dnd.switchable });
        this._drawer.setGroups(this._history.groups(), unread, {
            muted: new Set(Object.keys(Policy.mutedFromList(this._mutedApps))),
            cleared: this._history.groups(this._history.cleared()),
            showCleared: this._showCleared
        });
        this._persist();
        this._updateBlink();

        this.set_applet_icon_symbolic_name(this._dnd.active ? ICON_DND : ICON_NORMAL);
        if (this._showCount !== false && unread > 0) {
            this.set_applet_label(String(unread));
            this.hide_applet_label(false);
        } else {
            this.set_applet_label('');
            this.hide_applet_label(true);
        }
        let tip = _('Hush');
        if (unread > 0) tip += ' — ' + (unread === 1 ? _('1 unread notification') : _('%d unread notifications').replace('%d', String(unread)));
        if (this._dnd.active) tip += ' — ' + _('Do Not Disturb') + ': ' + this._dnd.label(_);
        this.set_applet_tooltip(tip);
    }

    // ── Settings → Test page (button callbacks, called by name over DBus) ──

    _sendTest(name) {
        if (this._destroyed) return;
        this._testNotify.send(name).then(
            id => global.log(LOG_PREFIX + 'test notification "' + name + '" sent (id ' + id + ')'),
            e => global.logWarning(LOG_PREFIX + 'test notification "' + name + '" failed: ' + e.message));
    }

    test_normal()    { this._sendTest('normal'); }
    test_low()       { this._sendTest('low'); }
    test_critical()  { this._sendTest('critical'); }
    test_actions()   { this._sendTest('actions'); }
    test_markup()    { this._sendTest('markup'); }
    test_transient() { this._sendTest('transient'); }
    test_silent()    { this._sendTest('silent'); }
    test_image()     { this._sendTest('image'); }
    test_app()       { this._sendTest('app'); }
    test_long()      { this._sendTest('long'); }
    test_updating()  { this._sendTest('updating'); }
    test_burst()     { this._sendTest('burst'); }

    test_toggle_dnd()  { this._toggleManualDnd(); }
    test_open_drawer() { if (!this._destroyed) this._drawer.open(); }

    // Takes a session inhibitor under the first listed app id, as OBS does
    // while recording, and releases it after 10 s.
    test_inhibit() {
        if (this._destroyed || this._testInhibit) return;
        const appId = this._inhibitorAppIds()[0] || 'obs';
        const params = new GLib.Variant('(susu)', [appId, 0, 'Hush test inhibitor', InhibitorsModule.Flags.IDLE]);
        Gio.DBus.session.call(InhibitorsModule.NAME, InhibitorsModule.PATH, InhibitorsModule.IFACE, 'Inhibit', params, null,
            Gio.DBusCallFlags.NONE, 5000, null, (c, res) => {
                let cookie = 0;
                try { [cookie] = c.call_finish(res).deep_unpack(); } catch (e) { global.logWarning(LOG_PREFIX + 'test inhibitor failed: ' + e.message); return; }
                if (this._destroyed) { this._uninhibit(cookie); return; }
                global.log(LOG_PREFIX + 'test inhibitor taken as "' + appId + '" for 10 s');
                const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10, () => {
                    this._testInhibit = null;
                    this._uninhibit(cookie);
                    return GLib.SOURCE_REMOVE;
                });
                this._testInhibit = { cookie, timer };
            });
    }

    _uninhibit(cookie) {
        Gio.DBus.session.call(InhibitorsModule.NAME, InhibitorsModule.PATH, InhibitorsModule.IFACE, 'Uninhibit',
            new GLib.Variant('(u)', [cookie]), null, Gio.DBusCallFlags.NONE, 5000, null, (c, res) => {
                try { c.call_finish(res); } catch (e) { /* session manager gone */ }
            });
    }

    // Dismisses and forgets every record the Test page produced (they carry
    // the x-hush-test hint); other notifications are left alone.
    test_clear() {
        if (this._destroyed) return;
        let n = 0;
        for (const rec of this._history.all()) {
            if (rec.test !== true) continue;
            this._banner.discard(rec.id);
            this._intake.close(rec.id, Parse.ClosedReason.DISMISSED);
            this._history.remove(rec.id);
            n++;
        }
        global.log(LOG_PREFIX + 'cleared ' + n + ' test notification(s)');
        this._refresh();
    }

    // ── Persistence, blink, mute, shortcuts ──────────────────────────────

    _persist() {
        if (this._persistHistory !== false) this._store.saveHistory(this._history.toJSON());
        const nextId = this._intake.nextId;
        if (nextId !== this._savedNextId) { this._savedNextId = nextId; this._store.saveState({ nextId }); }
    }

    _onPersistChanged() {
        if (this._destroyed) return;
        if (this._persistHistory === false) {
            this._store.deleteHistory();
            global.log(LOG_PREFIX + 'history persistence off; ' + this._store.historyPath + ' deleted');
        } else {
            this._store.saveHistory(this._history.toJSON());
            this._store.flush();
        }
    }

    // Blink the panel icon while an unread critical notification is waiting
    // (what the built-in applet does for critical ones).
    _updateBlink() {
        if (this._destroyed) return;
        const want = this._blinkOnNew !== false && this._history.visible().some(r => r.state === 'unread' && r.urgency === Parse.Urgency.CRITICAL);
        if (want && !this._blinkTimer) {
            this._blinkTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, BLINK_MS, () => {
                this._blinkDim = !this._blinkDim;
                if (this._applet_icon) this._applet_icon.opacity = this._blinkDim ? 70 : 255;
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!want && this._blinkTimer) {
            this._stopBlink();
        }
    }

    _stopBlink() {
        if (this._blinkTimer) { GLib.source_remove(this._blinkTimer); this._blinkTimer = 0; }
        this._blinkDim = false;
        if (this._applet_icon) this._applet_icon.opacity = 255;
    }

    _toggleMute(group) {
        if (this._destroyed || !group || !group.appId) return;
        const list = (Array.isArray(this._mutedApps) ? this._mutedApps : []).filter(e => e && typeof e.app === 'string');
        const id = group.appId.toLowerCase();
        const index = list.findIndex(e => e.app.trim().toLowerCase() === id);
        if (index >= 0) list.splice(index, 1);
        else list.push({ app: id, name: group.appLabel || id, drop: false });
        this._mutedApps = list;              // the bound setter writes the settings file
        global.log(LOG_PREFIX + (index >= 0 ? 'unmuted ' : 'muted ') + id);
        this._refresh();
    }

    _setKeybindings() {
        if (this._destroyed) return;
        const km = Main.keybindingManager;
        km.addXletHotKey(this, 'hush-open', this._keyOpen || '', () => this._drawer.toggle());
        km.addXletHotKey(this, 'hush-clear', this._keyClear || '', () => this._clearAll());
        km.addXletHotKey(this, 'hush-dnd', this._keyDnd || '', () => this._toggleManualDnd());
    }

    _removeKeybindings() {
        const km = Main.keybindingManager;
        for (const name of ['hush-open', 'hush-clear', 'hush-dnd']) {
            try { km.removeXletHotKey(this, name); } catch (e) { /* not registered */ }
        }
    }

    // ── Applet hooks ─────────────────────────────────────────────────────

    on_applet_clicked(event) {
        this._drawer.toggle();
    }

    on_applet_middle_clicked(event) {
        this._toggleManualDnd();
    }

    on_applet_removed_from_panel(deleteConfig) {
        // Cinnamon calls this on removal AND on reload. Restore checklist
        // (proposal §6), every step guarded so one failure cannot skip the next.
        this._destroyed = true;
        const step = (name, fn) => { try { fn(); } catch (e) { global.logError(LOG_PREFIX + 'restore step "' + name + '" failed: ' + e.message); } };

        step('close open records', () => this._intake.closeAll(Parse.ClosedReason.APP_CLOSED));
        step('destroy banners and sources', () => this._banner.destroy());
        step('restore stock handler', () => this._intake.uninstall());
        step('drawer', () => this._drawer.destroy());
        step('signals', () => {
            for (const [obj, id] of this._signals) { try { obj.disconnect(id); } catch (e) { /* gone */ } }
            this._signals = [];
        });
        step('tray hook', () => {
            if (this._trayHooked) { MessageTray.extensionsHandlingNotifications--; this._trayHooked = false; }
        });
        step('intake timers', () => this._intake.destroy());
        step('test sender', () => this._testNotify.destroy());
        step('schedule timer', () => { if (this._scheduleTimer) { GLib.source_remove(this._scheduleTimer); this._scheduleTimer = 0; } });
        step('triggers', () => {
            this._fullscreen.destroy();
            this._recording.destroy();
            if (this._inhibitors) { this._inhibitors.destroy(); this._inhibitors = null; }
            this._dndKey.destroy();
        });
        step('test inhibitor', () => {
            if (this._testInhibit) { GLib.source_remove(this._testInhibit.timer); this._uninhibit(this._testInhibit.cookie); this._testInhibit = null; }
        });
        step('hotkeys', () => this._removeKeybindings());
        step('blink', () => this._stopBlink());
        step('store', () => { this._persist(); this._store.destroy(); });
        step('settings', () => { if (this._settings) { this._settings.finalize(); this._settings = null; } });
        this._notifSettings = null;
        global.log(LOG_PREFIX + 'removed; stock notification handler restored');
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new HushApplet(metadata, orientation, panelHeight, instanceId);
}
