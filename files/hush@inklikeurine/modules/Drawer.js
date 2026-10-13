// Drawer.js — the notification list that slides in from the left or right
// screen edge, full work-area height. A chrome actor (never in the panel),
// modal while open so Escape and a click outside close it. Renders rows
// from History records; every user action is reported through callbacks
// and the applet decides what it means. Shell-only (imports.ui, St).
//
//   const drawer = new Drawer(applet, {
//       width: 380, direction: 'auto' | 'left' | 'right', gettext: _,
//       iconFor: (record, size) => St.Icon | null,
//       onDndToggle: () => …, onDismiss: r => …, onAction: (r, key) => …,
//       onActivate: r => …, onClearAll: () => …, onHushSettings: () => …,
//       onNotificationSettings: () => …, onOpened: () => …, onClosed: () => …,
//       onMuteToggle: group => …, onClearGroup: group => …,
//       onToggleCleared: () => …, onDeleteCleared: () => …
//   });
//   drawer.setDnd({ active, label, switchable });
//   drawer.setFresh([record ids])   // rows marked new until the drawer closes
//   drawer.setGroups(history.groups(), history.unreadCount(), {
//       muted: Set of app ids, cleared: history.groups(history.cleared()), showCleared: bool });
//   drawer.setNotice('Notification capture unavailable …') / setNotice(null)
//   drawer.open() / close() / toggle(); drawer.isOpen
//   drawer.destroy()   // releases the modal grab, the time timer and the chrome actor
//
// Colours: the drawer takes its background, text, border and accent from the
// running Cinnamon theme (probed on every open, so a theme switch is picked
// up); stylesheet.css holds layout and theme-neutral overlays only, plus a
// dark fallback for a theme that defines none of the probed classes.

const Main = imports.ui.main;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const Pango = imports.gi.Pango;
const PopupMenu = imports.ui.popupMenu;
const Tooltips = imports.ui.tooltips;

const Markup = require('./modules/Markup');
const TimeFmt = require('./modules/TimeFmt');

const SLIDE_MS = 200;
const TIME_REFRESH_S = 60;
const DIM = 150;            // opacity of secondary text (time, counts)
const CLOSE_IDLE = 90;      // opacity of a row's × until the row is hovered or focused
const FALLBACK_ACCENT = { red: 82, green: 148, blue: 226 };
const PanelLoc = Object.freeze({ top: 0, bottom: 1, left: 2, right: 3 });

function rgba(c, alpha) {
    return 'rgba(' + c.red + ',' + c.green + ',' + c.blue + ',' + alpha + ')';
}

// WCAG relative luminance and contrast, to catch a theme whose menu text
// colour we could not read (it would be inherited, not the menu's own).
function luminance(c) {
    const ch = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * ch(c.red) + 0.7152 * ch(c.green) + 0.0722 * ch(c.blue);
}

function contrast(a, b) {
    const la = luminance(a), lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

class Drawer {
    constructor(applet, opts) {
        const o = opts || {};
        this._applet = applet;
        this._ = typeof o.gettext === 'function' ? o.gettext : (s => s);
        this.width = o.width || 380;
        this.direction = o.direction || 'auto';
        this._iconFor = o.iconFor || (() => null);
        this._cb = {
            onDndToggle: o.onDndToggle || (() => {}),
            onDismiss: o.onDismiss || (() => {}),
            onAction: o.onAction || (() => {}),
            onActivate: o.onActivate || (() => {}),
            onClearAll: o.onClearAll || (() => {}),
            onHushSettings: o.onHushSettings || (() => {}),
            onNotificationSettings: o.onNotificationSettings || (() => {}),
            onOpened: o.onOpened || (() => {}),
            onClosed: o.onClosed || (() => {}),
            onMuteToggle: o.onMuteToggle || (() => {}),
            onClearGroup: o.onClearGroup || (() => {}),
            onToggleCleared: o.onToggleCleared || (() => {}),
            onDeleteCleared: o.onDeleteCleared || (() => {})
        };

        this.isOpen = false;
        this._modal = false;
        this._capturedId = 0;
        this._timeTimer = 0;
        this._destroyed = false;
        this._side = 'right';
        this._groups = [];
        this._unread = 0;
        this._muted = new Set();
        this._cleared = [];
        this._showCleared = false;
        this._fresh = new Set();
        this._dndActive = false;
        this._switchable = true;
        this._accent = FALLBACK_ACCENT;
        this._rows = [];            // [{ actor, record }] of the live (not cleared) rows, in order
        this._timeLabels = [];      // [{ label, time }] refreshed while open

        this._build();
        Main.layoutManager.addChrome(this.actor, { visibleInFullscreen: false, affectsStruts: false, affectsInputRegion: true });
        this.actor.hide();
    }

    // ── actors ────────────────────────────────────────────────────────────

    _build() {
        const _ = this._;
        this.actor = new St.BoxLayout({ style_class: 'hush-drawer', vertical: true, reactive: true, width: this.width });

        // Header: DND switch + status line (the status line only while DND is on).
        const header = new St.BoxLayout({ style_class: 'hush-header', vertical: true });
        this._header = header;
        const dndRow = new St.BoxLayout({ style_class: 'hush-dnd-row' });
        const dndLabel = new St.Label({ style_class: 'hush-dnd-label', text: _('Do Not Disturb'), y_align: Clutter.ActorAlign.CENTER });
        this._switch = new PopupMenu.Switch(false);
        this._switchButton = new St.Button({ style_class: 'hush-dnd-switch', child: this._switch.actor, y_align: Clutter.ActorAlign.CENTER });
        this._switchButton.connect('clicked', () => { if (this._switchable) this._cb.onDndToggle(); });
        this._switchTooltip = new Tooltips.Tooltip(this._switchButton, _('Turn Do Not Disturb on or off'));
        dndRow.add(dndLabel, { expand: true, x_fill: true, y_fill: false, y_align: St.Align.MIDDLE });
        dndRow.add(this._switchButton, { expand: false, x_fill: false, y_fill: false, y_align: St.Align.MIDDLE });
        this._statusRow = new St.BoxLayout({ style_class: 'hush-status-row' });
        this._statusIcon = new St.Icon({ style_class: 'hush-status-icon', icon_name: 'notifications-disabled-symbolic', icon_type: St.IconType.SYMBOLIC, icon_size: 16, y_align: Clutter.ActorAlign.CENTER });
        this._status = new St.Label({ style_class: 'hush-status', text: _('Off'), y_align: Clutter.ActorAlign.CENTER });
        this._status.clutter_text.line_wrap = true;
        this._status.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._statusRow.add(this._statusIcon, { y_fill: false, y_align: St.Align.MIDDLE });
        this._statusRow.add(this._status, { expand: true, x_fill: true, y_fill: false, y_align: St.Align.MIDDLE });
        this._statusRow.hide();
        header.add(dndRow, { x_fill: true });
        header.add(this._statusRow, { x_fill: true });
        this.actor.add(header, { x_fill: true });

        // Degraded-mode notice, hidden unless set.
        this._notice = new St.Label({ style_class: 'hush-notice' });
        this._notice.clutter_text.line_wrap = true;
        this._notice.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._notice.hide();
        this.actor.add(this._notice, { x_fill: true });

        // List.
        this._scroll = new St.ScrollView({ style_class: 'hush-scroll', x_fill: true, y_fill: true, y_align: St.Align.START });
        this._scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        this._scroll.set_clip_to_allocation(true);
        this._list = new St.BoxLayout({ style_class: 'hush-list', vertical: true });
        this._scroll.add_actor(this._list);
        this.actor.add(this._scroll, { expand: true, x_fill: true, y_fill: true });

        // Footer: one text button, then icon buttons so it fits the minimum width.
        const footer = new St.BoxLayout({ style_class: 'hush-footer' });
        this._footer = footer;
        this._clearButton = new St.Button({ style_class: 'hush-footer-button', label: _('Clear all'), can_focus: true, reactive: true });
        this._clearButton.connect('clicked', () => this._cb.onClearAll());
        this._clearedButton = this._iconButton('hush-footer-icon', 'document-open-recent-symbolic', 16, _('Show cleared'), () => this._cb.onToggleCleared());
        this._clearedTooltip = this._clearedButton._hushTooltip;
        const hushSettings = this._iconButton('hush-footer-icon', 'emblem-system-symbolic', 16, _('Hush settings'), () => this._cb.onHushSettings());
        const notifSettings = this._iconButton('hush-footer-icon', 'preferences-system-notifications-symbolic', 16, _('Notification settings'), () => this._cb.onNotificationSettings());
        footer.add(this._clearButton, { expand: false, y_fill: false, y_align: St.Align.MIDDLE });
        footer.add(new St.Bin(), { expand: true });
        footer.add(this._clearedButton, { expand: false, y_fill: false, y_align: St.Align.MIDDLE });
        footer.add(hushSettings, { expand: false, y_fill: false, y_align: St.Align.MIDDLE });
        footer.add(notifSettings, { expand: false, y_fill: false, y_align: St.Align.MIDDLE });
        this.actor.add(footer, { x_fill: true });

        this.actor.connect('key-press-event', (a, ev) => this._onKeyPress(ev));
    }

    _iconButton(styleClass, iconName, size, tooltip, onClick) {
        const b = new St.Button({
            style_class: styleClass, reactive: true, can_focus: true,
            child: new St.Icon({ icon_name: iconName, icon_type: St.IconType.SYMBOLIC, icon_size: size })
        });
        b._hushTooltip = new Tooltips.Tooltip(b, tooltip);
        b.connect('clicked', onClick);
        return b;
    }

    // ── theme ─────────────────────────────────────────────────────────────

    // Reads a colour the running theme gives `styleClass` (optionally in a
    // pseudo-class). The probe is a hidden child, so it is on the stage and
    // has a theme node. Returns null when the theme leaves it transparent.
    _probe(styleClass, pseudo, what) {
        let w = null;
        try {
            w = new St.Bin({ style_class: styleClass });
            if (pseudo) w.add_style_pseudo_class(pseudo);
            w.hide();
            this.actor.add_child(w);
            const node = w.get_theme_node();
            // A border colour means nothing without a border width (St's
            // default colour is opaque black).
            if (what === 'border' && !(node.get_border_width(St.Side.LEFT) > 0)) return null;
            const c = what === 'fg' ? node.get_foreground_color()
                : what === 'border' ? node.get_border_color(St.Side.LEFT)
                : node.get_background_color();
            return c && c.alpha > 0 ? { red: c.red, green: c.green, blue: c.blue, alpha: c.alpha } : null;
        } catch (e) {
            return null;
        } finally {
            if (w) w.destroy();
        }
    }

    _applyTheme() {
        // Background, text and border from the same theme class, the first
        // of these that paints a background; none → stylesheet fallback.
        let bg = null, fg = null, border = null;
        for (const cls of ['menu', 'popup-menu-content', 'popup-menu']) {
            bg = this._probe(cls, null, 'bg');
            if (!bg) continue;
            fg = this._probe(cls, null, 'fg');
            border = this._probe(cls, null, 'border');
            break;
        }
        if (bg && (!fg || contrast(fg, bg) < 3))
            fg = luminance(bg) > 0.4 ? { red: 46, green: 46, blue: 46, alpha: 255 } : { red: 232, green: 232, blue: 232, alpha: 255 };
        this._accent = this._probe('popup-menu-item', 'active', 'bg') || this._probe('popup-menu-item', 'hover', 'bg') || FALLBACK_ACCENT;
        let style = '';
        // Opaque background even if the theme's menus are translucent: the
        // drawer sits over windows at full height.
        if (bg) style += 'background-color: rgb(' + bg.red + ',' + bg.green + ',' + bg.blue + ');';
        if (fg) style += 'color: ' + rgba(fg, (fg.alpha / 255).toFixed(3)) + ';';
        if (border) style += 'border-color: ' + rgba(border, (border.alpha / 255).toFixed(3)) + ';';
        this.actor.set_style(style || null);
        this._statusIcon.set_style('color: ' + rgba(this._accent, 1) + ';');
        this._styleHeader();
    }

    _styleHeader() {
        this._header.set_style(this._dndActive
            ? 'background-color: ' + rgba(this._accent, 0.16) + '; border-bottom-color: ' + rgba(this._accent, 0.6) + ';'
            : null);
    }

    // ── state in ──────────────────────────────────────────────────────────

    setDnd(state) {
        if (this._destroyed) return;
        const _ = this._;
        const s = state || {};
        this._dndActive = !!s.active;
        this._switchable = s.switchable !== false;
        this._switch.setToggleState(this._dndActive);
        this._status.set_text(s.label || '');
        if (this._dndActive) {
            this._status.add_style_class_name('hush-status-on');
            this._statusRow.show();
        } else {
            this._status.remove_style_class_name('hush-status-on');
            this._statusRow.hide();
        }
        this._styleHeader();
        // Stays reactive when locked so its tooltip can say why.
        this._switchButton.opacity = this._switchable ? 255 : 128;
        this._switchTooltip.set_text(this._switchable
            ? _('Turn Do Not Disturb on or off')
            : _('Turned off in System Settings → Notifications'));
    }

    setFresh(ids) {
        this._fresh = new Set(Array.isArray(ids) ? ids : []);
    }

    setNotice(text) {
        if (this._destroyed) return;
        if (text) { this._notice.set_text(text); this._notice.show(); }
        else this._notice.hide();
    }

    setWidth(width) {
        this.width = width;
        if (!this._destroyed) {
            this.actor.width = width;
            if (this.isOpen) this._place(false);
        }
    }

    setDirection(direction) {
        this.direction = direction;
        if (this.isOpen && !this._destroyed) this._place(false);
    }

    // extra: { muted: Set<appId>, cleared: [groups], showCleared: bool }
    setGroups(groups, unread, extra) {
        if (this._destroyed) return;
        const x = extra || {};
        this._groups = groups || [];
        this._unread = unread | 0;
        this._muted = x.muted instanceof Set ? x.muted : new Set();
        this._cleared = Array.isArray(x.cleared) ? x.cleared : [];
        this._showCleared = x.showCleared === true;
        this._rebuild();
    }

    _vadjustment() {
        try {
            return this._scroll.vscroll ? this._scroll.vscroll.adjustment : null;
        } catch (e) {
            return null;
        }
    }

    _focusedRowIndex() {
        let a = global.stage.get_key_focus();
        while (a && a !== this.actor) {
            const i = this._rows.findIndex(r => r.actor === a);
            if (i >= 0) return i;
            a = a.get_parent();
        }
        return -1;
    }

    _rebuild() {
        const _ = this._;
        // A notification arriving while the drawer is open must not move the
        // list under the pointer or take keyboard focus away.
        const adj = this._vadjustment();
        const scrollKeep = adj ? adj.value : 0;
        const focusIndex = this.isOpen ? this._focusedRowIndex() : -1;
        const focusId = focusIndex >= 0 ? this._rows[focusIndex].record.id : null;

        this._list.destroy_all_children();
        this._rows = [];
        this._timeLabels = [];
        let total = 0;
        for (const g of this._groups) total += g.records.length;
        let clearedTotal = 0;
        for (const g of this._cleared) clearedTotal += g.records.length;
        this._clearButton.reactive = total > 0;
        this._clearButton.opacity = total > 0 ? 255 : 128;
        const clearedUsable = clearedTotal > 0 || this._showCleared;
        this._clearedButton.reactive = clearedUsable;
        this._clearedButton.opacity = clearedUsable ? 255 : 128;
        this._clearedButton.checked = this._showCleared;
        this._clearedTooltip.set_text(this._showCleared ? _('Hide cleared') : _('Show cleared'));

        if (total === 0) this._list.add(this._buildEmpty(), { x_fill: true });
        for (const g of this._groups) this._list.add(this._buildGroup(g, false), { x_fill: true });
        if (this._showCleared) {
            const section = new St.BoxLayout({ style_class: 'hush-cleared-section', vertical: true });
            const head = new St.BoxLayout({ style_class: 'hush-cleared-header' });
            const title = new St.Label({ style_class: 'hush-cleared-title', y_align: Clutter.ActorAlign.CENTER,
                text: clearedTotal === 0 ? _('No cleared notifications') : (clearedTotal === 1 ? _('1 cleared notification') : _('%d cleared notifications').replace('%d', String(clearedTotal))) });
            title.opacity = DIM;
            head.add(title, { expand: true, x_fill: true, y_fill: false, y_align: St.Align.MIDDLE });
            if (clearedTotal > 0) {
                const del = new St.Button({ style_class: 'hush-footer-button', label: _('Delete cleared'), can_focus: true, reactive: true });
                del.connect('clicked', () => this._cb.onDeleteCleared());
                head.add(del, { y_fill: false, y_align: St.Align.MIDDLE });
            }
            section.add(head, { x_fill: true });
            for (const g of this._cleared) {
                const box = this._buildGroup(g, true);
                box.opacity = DIM;
                section.add(box, { x_fill: true });
            }
            this._list.add(section, { x_fill: true });
        }

        if (adj && scrollKeep > 0) adj.value = scrollKeep;
        if (focusIndex >= 0 && this._rows.length > 0) {
            let i = this._rows.findIndex(r => r.record.id === focusId);
            if (i < 0) i = Math.min(focusIndex, this._rows.length - 1);
            this._rows[i].actor.grab_key_focus();
        }
    }

    _buildEmpty() {
        const _ = this._;
        const box = new St.BoxLayout({ style_class: 'hush-empty', vertical: true });
        const icon = new St.Icon({
            style_class: 'hush-empty-icon', icon_type: St.IconType.SYMBOLIC, icon_size: 48,
            icon_name: this._dndActive ? 'notifications-disabled-symbolic' : 'preferences-system-notifications-symbolic'
        });
        icon.opacity = 110;
        box.add(icon, { x_fill: false, x_align: St.Align.MIDDLE });
        box.add(new St.Label({ style_class: 'hush-empty-title', text: _('No notifications') }), { x_fill: false, x_align: St.Align.MIDDLE });
        if (this._dndActive) {
            const more = new St.Label({ style_class: 'hush-empty-text', text: _('Do Not Disturb is on — new notifications will wait here') });
            more.clutter_text.line_wrap = true;
            more.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            more.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            more.opacity = DIM;
            box.add(more, { x_fill: true });
        }
        return box;
    }

    // One application: header (icon, name, count, hover controls) + rows.
    // The mute and clear buttons appear while the pointer is over the group;
    // a muted application shows a "Muted" pill instead, always visible.
    _buildGroup(group, cleared) {
        const _ = this._;
        const box = new St.BoxLayout({ style_class: 'hush-group', vertical: true, reactive: !cleared, track_hover: !cleared });
        const header = new St.BoxLayout({ style_class: 'hush-group-header' });
        const first = group.records[0];
        let icon = null;
        try { icon = this._iconFor(first, 20); } catch (e) { icon = null; }
        if (icon) header.add(icon, { y_align: St.Align.MIDDLE, y_fill: false });
        const label = new St.Label({ style_class: 'hush-group-label', text: group.appLabel || group.appId, y_align: Clutter.ActorAlign.CENTER });
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        header.add(label, { expand: true, x_fill: true, y_fill: false, y_align: St.Align.MIDDLE });
        if (group.records.length > 1) {
            const count = new St.Label({ style_class: 'hush-group-count', text: String(group.records.length), y_align: Clutter.ActorAlign.CENTER });
            count.opacity = DIM;
            header.add(count, { y_fill: false, y_align: St.Align.MIDDLE });
        }
        if (!cleared) {
            const muted = this._muted.has(group.appId);
            const hoverOnly = [];
            if (muted) {
                const pillBox = new St.BoxLayout({ style_class: 'hush-muted-pill-box' });
                pillBox.add(new St.Icon({ icon_name: 'notifications-disabled-symbolic', icon_type: St.IconType.SYMBOLIC, icon_size: 12 }), { y_fill: false, y_align: St.Align.MIDDLE });
                pillBox.add(new St.Label({ text: _('Muted'), y_align: Clutter.ActorAlign.CENTER }), { y_fill: false, y_align: St.Align.MIDDLE });
                const pill = new St.Button({ style_class: 'hush-muted-pill', reactive: true, can_focus: true, child: pillBox });
                new Tooltips.Tooltip(pill, _('Unmute this application'));
                pill.connect('clicked', () => this._cb.onMuteToggle(group));
                header.add(pill, { y_fill: false, y_align: St.Align.MIDDLE });
            } else {
                const mute = this._iconButton('hush-group-button', 'preferences-system-notifications-symbolic', 14, _('Mute this application'), () => this._cb.onMuteToggle(group));
                hoverOnly.push(mute);
                header.add(mute, { y_fill: false, y_align: St.Align.MIDDLE });
            }
            const clear = this._iconButton('hush-group-button', 'window-close-symbolic', 14, _('Clear this application'), () => this._cb.onClearGroup(group));
            hoverOnly.push(clear);
            header.add(clear, { y_fill: false, y_align: St.Align.MIDDLE });
            const sync = () => {
                const on = box.hover || hoverOnly.some(b => b.has_key_focus());
                for (const b of hoverOnly) { b.opacity = on ? 255 : 0; b.reactive = on; }
            };
            box.connect('notify::hover', sync);
            for (const b of hoverOnly) {
                b.connect('key-focus-in', sync);
                b.connect('key-focus-out', sync);
            }
            sync();
        }
        box.add(header, { x_fill: true });
        for (const rec of group.records) box.add(this._buildRow(rec, cleared), { x_fill: true });
        return box;
    }

    _buildRow(record, cleared) {
        const row = new St.BoxLayout({ style_class: 'hush-row', vertical: true, reactive: !cleared, track_hover: !cleared, can_focus: !cleared });
        if (cleared) row.add_style_class_name('hush-row-cleared');
        const fresh = !cleared && (record.state === 'unread' || this._fresh.has(record.id));
        if (record.urgency === 2) row.add_style_class_name('hush-critical');
        else if (fresh) {
            row.add_style_class_name('hush-unread');
            row.set_style('border-left-color: ' + rgba(this._accent, 1) + ';');
        }

        const top = new St.BoxLayout({ style_class: 'hush-row-top' });
        const title = new St.Label({ style_class: 'hush-row-title', y_align: Clutter.ActorAlign.CENTER });
        title.clutter_text.set_markup('<b>' + Markup.escape(Markup.plain(record.summary || '')) + '</b>');
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        const time = new St.Label({ style_class: 'hush-row-time', reactive: true, text: TimeFmt.relative(record.time, Date.now(), this._), y_align: Clutter.ActorAlign.CENTER });
        time.opacity = DIM;
        new Tooltips.Tooltip(time, TimeFmt.exact(record.time));
        this._timeLabels.push({ label: time, time: record.time });
        top.add(title, { expand: true, x_fill: true, y_fill: false, y_align: St.Align.MIDDLE });
        top.add(time, { y_fill: false, y_align: St.Align.MIDDLE });
        let close = null;
        if (!cleared) {
            close = new St.Button({
                style_class: 'hush-row-close', reactive: true, can_focus: true,
                child: new St.Icon({ icon_name: 'window-close-symbolic', icon_type: St.IconType.SYMBOLIC, icon_size: 14 })
            });
            close.connect('clicked', () => this._cb.onDismiss(record));
            top.add(close, { y_fill: false, y_align: St.Align.MIDDLE });
        }
        row.add(top, { x_fill: true });

        if (record.body) {
            // Wrapped, never ellipsized: an ellipsized wrapping label has a
            // minimum height of a few pixels and the scrollable list lays rows
            // out at minimum height once it overflows, so they would overlap.
            // Long bodies are cut by text instead (Markup.clipBody).
            const body = new St.Label({ style_class: 'hush-row-body' });
            body.clutter_text.set_markup(Markup.clipBody(record.body, { maxLines: 4, maxChars: 240 }));
            body.clutter_text.line_wrap = true;
            body.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            body.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            row.add(body, { x_fill: true });
        }

        const actions = cleared ? [] : (record.actions || []).filter(a => a.key !== 'default');
        if (actions.length) {
            const live = !record.closed && !record.senderGone;
            const box = new St.BoxLayout({ style_class: 'hush-row-actions' });
            for (const a of actions) {
                const b = new St.Button({ style_class: 'hush-action-button', label: a.label || a.key, reactive: live, can_focus: live });
                if (!live) b.opacity = 128;
                b.connect('clicked', () => this._cb.onAction(record, a.key));
                box.add(b);
            }
            row.add(box, { x_fill: true });
        }

        if (cleared) return row;
        // × is quiet until the row is hovered or focused.
        const syncClose = () => { close.opacity = (row.hover || row.has_key_focus() || close.hover || close.has_key_focus()) ? 255 : CLOSE_IDLE; };
        row.connect('notify::hover', syncClose);
        row.connect('key-focus-in', syncClose);
        row.connect('key-focus-out', syncClose);
        close.connect('notify::hover', syncClose);
        syncClose();
        row.connect('button-release-event', (actor, ev) => {
            if (ev.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
            const src = ev.get_source();
            if (src instanceof St.Button) return Clutter.EVENT_PROPAGATE;
            this._cb.onActivate(record);
            return Clutter.EVENT_STOP;
        });
        this._rows.push({ actor: row, record });
        return row;
    }

    _refreshTimes() {
        const now = Date.now();
        for (const t of this._timeLabels) t.label.set_text(TimeFmt.relative(t.time, now, this._));
    }

    _startTimeTimer() {
        this._stopTimeTimer();
        this._timeTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TIME_REFRESH_S, () => {
            if (this._destroyed || !this.isOpen) { this._timeTimer = 0; return GLib.SOURCE_REMOVE; }
            this._refreshTimes();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTimeTimer() {
        if (this._timeTimer) { GLib.source_remove(this._timeTimer); this._timeTimer = 0; }
    }

    // ── geometry ──────────────────────────────────────────────────────────

    _monitorIndex() {
        const panel = this._applet.panel;
        if (panel && typeof panel.monitorIndex === 'number') return panel.monitorIndex;
        return Main.layoutManager.primaryIndex;
    }

    // Work area of the monitor minus any auto-hide panels (they hold no
    // strut), the way layout.js does it for its own work-area constraints.
    _workArea(index) {
        const mon = Main.layoutManager.monitors[index] || Main.layoutManager.primaryMonitor;
        let rect = { x: mon.x, y: mon.y, width: mon.width, height: mon.height };
        try {
            const ws = global.screen.get_active_workspace();
            const wa = ws.get_work_area_for_monitor(index);
            rect = { x: wa.x, y: wa.y, width: wa.width, height: wa.height };
        } catch (e) {
            // fall back to the raw monitor and subtract every panel below
        }
        for (let pos = 0; pos < 4; pos++) {
            let panel = null;
            try { panel = Main.panelManager.getPanel(index, pos); } catch (e) { panel = null; }
            if (!panel || !panel.actor) continue;
            let hideable = false;
            try { hideable = typeof panel.isHideable === 'function' ? panel.isHideable() : false; } catch (e) { hideable = false; }
            const strutted = rect.x !== mon.x || rect.y !== mon.y || rect.width !== mon.width || rect.height !== mon.height;
            if (!hideable && strutted) continue;   // already excluded by the work area
            const h = panel.actor.get_height(), w = panel.actor.get_width();
            switch (pos) {
                case PanelLoc.top: rect.y += h; rect.height -= h; break;
                case PanelLoc.bottom: rect.height -= h; break;
                case PanelLoc.left: rect.x += w; rect.width -= w; break;
                case PanelLoc.right: rect.width -= w; break;
            }
        }
        return { mon, rect };
    }

    _resolveSide(mon) {
        if (this.direction === 'left' || this.direction === 'right') return this.direction;
        const panel = this._applet.panel;
        if (panel && panel.panelPosition === PanelLoc.left) return 'left';
        if (panel && panel.panelPosition === PanelLoc.right) return 'right';
        try {
            const [ax] = this._applet.actor.get_transformed_position();
            const centre = ax + this._applet.actor.width / 2;
            return centre < mon.x + mon.width / 2 ? 'left' : 'right';
        } catch (e) {
            return 'right';
        }
    }

    _place(animate) {
        const index = this._monitorIndex();
        const { mon, rect } = this._workArea(index);
        const side = this._resolveSide(mon);
        this._side = side;
        // Border and shadow on the inner edge only.
        this.actor.remove_style_class_name(side === 'left' ? 'hush-side-right' : 'hush-side-left');
        this.actor.add_style_class_name(side === 'left' ? 'hush-side-left' : 'hush-side-right');
        const width = Math.min(this.width, rect.width);
        const targetX = side === 'left' ? rect.x : rect.x + rect.width - width;
        const hiddenX = side === 'left' ? rect.x - width : rect.x + rect.width;
        this.actor.set_size(width, rect.height);
        this.actor.set_position(animate ? hiddenX : targetX, rect.y);
        this.actor.remove_all_transitions();
        if (animate) this.actor.ease({ x: targetX, duration: SLIDE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
        return { targetX, hiddenX };
    }

    // ── open / close ──────────────────────────────────────────────────────

    open() {
        if (this._destroyed || this.isOpen) return false;
        this.isOpen = true;
        this.actor.show();
        this._applyTheme();
        this._place(true);
        this._grab();
        this._cb.onOpened();
        this._refreshTimes();
        this._startTimeTimer();
        return true;
    }

    close() {
        if (this._destroyed || !this.isOpen) return false;
        this.isOpen = false;
        this._fresh = new Set();
        this._stopTimeTimer();
        this._ungrab();
        const { hiddenX } = this._place(false);
        this.actor.remove_all_transitions();
        this.actor.ease({
            x: hiddenX, duration: SLIDE_MS, mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => { if (!this.isOpen && !this._destroyed) this.actor.hide(); }
        });
        this._cb.onClosed();
        return true;
    }

    toggle() {
        return this.isOpen ? this.close() : this.open();
    }

    _grab() {
        if (this._modal) return;
        if (!Main.pushModal(this.actor)) {
            global.logWarning('[hush] could not take a modal grab for the drawer');
            return;
        }
        this._modal = true;
        this._capturedId = global.stage.connect('captured-event', (stage, ev) => this._onCapturedEvent(ev));
    }

    _ungrab() {
        if (this._capturedId) { global.stage.disconnect(this._capturedId); this._capturedId = 0; }
        if (this._modal) { this._modal = false; Main.popModal(this.actor); }
    }

    _contains(actor, target) {
        let a = target;
        while (a) {
            if (a === actor) return true;
            a = a.get_parent();
        }
        return false;
    }

    _onCapturedEvent(ev) {
        const type = ev.type();
        if (type === Clutter.EventType.KEY_PRESS) return this._onKeyPress(ev);
        if (type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.TOUCH_BEGIN) {
            const src = ev.get_source();
            if (this._contains(this.actor, src)) return Clutter.EVENT_PROPAGATE;
            // A press on the applet itself toggles: close here and eat the
            // event so on_applet_clicked does not reopen it.
            this.close();
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.BUTTON_RELEASE) {
            const src = ev.get_source();
            if (this._contains(this.actor, src)) return Clutter.EVENT_PROPAGATE;
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // Keyboard (secondary to the mouse): nothing is focused on open, so a
    // mouse user sees no selection; the first arrow key focuses the first row.
    // Up/Down move between rows, Enter opens, Delete dismisses, Tab walks the
    // buttons, Escape closes.
    _onKeyPress(ev) {
        const sym = ev.get_key_symbol();
        if (sym === Clutter.KEY_Escape) { this.close(); return Clutter.EVENT_STOP; }
        if (!this.isOpen) return Clutter.EVENT_PROPAGATE;
        const i = this._focusedRowIndex();
        if (sym === Clutter.KEY_Down || sym === Clutter.KEY_Up) {
            if (this._rows.length === 0) return Clutter.EVENT_STOP;
            let next = i < 0 ? 0 : i + (sym === Clutter.KEY_Down ? 1 : -1);
            next = Math.max(0, Math.min(this._rows.length - 1, next));
            this._rows[next].actor.grab_key_focus();
            return Clutter.EVENT_STOP;
        }
        if (i >= 0 && (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter)) {
            const focus = global.stage.get_key_focus();
            if (focus !== this._rows[i].actor) return Clutter.EVENT_PROPAGATE;   // a focused button handles its own Enter
            this._cb.onActivate(this._rows[i].record);
            return Clutter.EVENT_STOP;
        }
        if (i >= 0 && sym === Clutter.KEY_Delete) {
            this._cb.onDismiss(this._rows[i].record);
            return Clutter.EVENT_STOP;
        }
        if (sym === Clutter.KEY_Tab || sym === Clutter.KEY_ISO_Left_Tab) {
            const back = sym === Clutter.KEY_ISO_Left_Tab || (ev.get_state() & Clutter.ModifierType.SHIFT_MASK);
            const from = global.stage.get_key_focus();
            this.actor.navigate_focus(this._contains(this.actor, from) ? from : null,
                back ? St.DirectionType.TAB_BACKWARD : St.DirectionType.TAB_FORWARD, true);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    destroy() {
        if (this._destroyed) return;
        this.isOpen = false;
        this._stopTimeTimer();
        this._ungrab();
        this._destroyed = true;
        this._rows = [];
        this._timeLabels = [];
        try { this.actor.remove_all_transitions(); } catch (e) { /* ignore */ }
        try { Main.layoutManager.removeChrome(this.actor); } catch (e) { /* ignore */ }
        try { this.actor.destroy(); } catch (e) { /* ignore */ }
        this.actor = null;
    }
}
