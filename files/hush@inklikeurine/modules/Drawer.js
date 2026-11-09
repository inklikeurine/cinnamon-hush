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
// The list is updated in place: one actor per group and per record, kept
// across refreshes (modules/ListDiff.js works out what entered, what left
// and the order), so scroll position, hover and keyboard focus survive and
// only the changed rows move. Clicking an application's header folds its
// group; folds are forgotten when the drawer closes. Motion (the slide,
// rows growing in and sliding out, the Clear all cascade, groups folding)
// follows Cinnamon's own menu setting (Main.wm.desktop_effects_menus:
// Effects → "Effects on menus"); with it off every change is instant.
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

const Markup = require('./modules/Markup');
const TimeFmt = require('./modules/TimeFmt');
const EdgeTooltip = require('./modules/EdgeTooltip');
const ListDiff = require('./modules/ListDiff');

const OPEN_MS = 250;
const CLOSE_MS = 180;
const ROW_MS = 200;          // a row growing in
const LEAVE_MS = 220;        // a row sliding out
const COLLAPSE_MS = 160;     // the gap closing after it
const FOLD_MS = 200;         // a group folding / unfolding
const FADE_MS = 150;
const STAGGER_MS = 35;
const STAGGER_CAP_MS = 280;
const ENTER_OFFSET = 16;     // px a new row slides in from, edge side

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
        this._total = 0;
        this._muted = new Set();
        this._cleared = [];
        this._showCleared = false;
        this._fresh = new Set();
        this._dndActive = false;
        this._switchable = true;
        this._accent = FALLBACK_ACCENT;
        this._rows = [];                 // [{ actor, record }] live rows a keyboard can reach, in order
        this._groupViews = new Map();    // group key → view (live section)
        this._clearedViews = new Map();  // group key → view (cleared section)
        this._collapsed = new Set();     // group keys folded by the user; forgotten on close
        this._leaveSeq = 0;
        this._staggerIndex = 0;

        this._build();
        Main.layoutManager.addChrome(this.actor, { visibleInFullscreen: false, affectsStruts: false, affectsInputRegion: true });
        this.actor.hide();
    }

    // ── actors ────────────────────────────────────────────────────────────

    _build() {
        const _ = this._;
        this.actor = new St.BoxLayout({ style_class: 'hush-drawer', vertical: true, reactive: true, width: this.width });

        // Header: the whole "Do Not Disturb" row is the switch; the status
        // line below it shows only while Do Not Disturb is on.
        const header = new St.BoxLayout({ style_class: 'hush-header', vertical: true });
        this._header = header;
        this._dndRow = new St.Button({ style_class: 'hush-dnd-row', reactive: true, can_focus: true, x_fill: true, y_fill: true });
        const dndBox = new St.BoxLayout({ style_class: 'hush-dnd-box' });
        const dndLabel = new St.Label({ style_class: 'hush-dnd-label', text: _('Do Not Disturb'), y_align: Clutter.ActorAlign.CENTER });
        this._switch = new PopupMenu.Switch(false);
        dndBox.add(dndLabel, { expand: true, x_fill: true, y_fill: false, y_align: St.Align.MIDDLE });
        dndBox.add(this._switch.actor, { expand: false, x_fill: false, y_fill: false, y_align: St.Align.MIDDLE });
        this._dndRow.set_child(dndBox);
        // Stays reactive when locked so its tooltip can say why.
        this._dndRow.connect('clicked', () => { if (this._switchable) this._cb.onDndToggle(); });
        this._switchTooltip = EdgeTooltip.create(this._dndRow, _('Turn Do Not Disturb on or off'));
        this._statusRow = new St.BoxLayout({ style_class: 'hush-status-row' });
        this._statusIcon = new St.Icon({ style_class: 'hush-status-icon', icon_name: 'notifications-disabled-symbolic', icon_type: St.IconType.SYMBOLIC, icon_size: 16, y_align: Clutter.ActorAlign.CENTER });
        this._status = new St.Label({ style_class: 'hush-status', text: _('Off'), y_align: Clutter.ActorAlign.CENTER });
        this._status.clutter_text.line_wrap = true;
        this._status.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._statusRow.add(this._statusIcon, { y_fill: false, y_align: St.Align.MIDDLE });
        this._statusRow.add(this._status, { expand: true, x_fill: true, y_fill: false, y_align: St.Align.MIDDLE });
        this._statusRow.hide();
        header.add(this._dndRow, { x_fill: true });
        header.add(this._statusRow, { x_fill: true });
        this.actor.add(header, { x_fill: true });

        // Degraded-mode notice, hidden unless set.
        this._notice = new St.Label({ style_class: 'hush-notice' });
        this._notice.clutter_text.line_wrap = true;
        this._notice.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._notice.hide();
        this.actor.add(this._notice, { x_fill: true });

        // List: live groups, then the cleared section, in one scroll view.
        this._scroll = new St.ScrollView({ style_class: 'hush-scroll', x_fill: true, y_fill: true, y_align: St.Align.START });
        this._scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        this._scroll.set_clip_to_allocation(true);
        const scrollBox = new St.BoxLayout({ style_class: 'hush-scroll-box', vertical: true });
        this._list = new St.BoxLayout({ style_class: 'hush-list', vertical: true });
        scrollBox.add(this._list, { x_fill: true });
        this._clearedSection = new St.BoxLayout({ style_class: 'hush-cleared-section', vertical: true });
        const clearedHead = new St.BoxLayout({ style_class: 'hush-cleared-header' });
        this._clearedTitle = new St.Label({ style_class: 'hush-cleared-title', y_align: Clutter.ActorAlign.CENTER });
        this._clearedTitle.opacity = DIM;
        this._deleteClearedButton = new St.Button({ style_class: 'hush-footer-button', label: _('Delete cleared'), can_focus: true, reactive: true });
        this._deleteClearedButton.connect('clicked', () => this._cb.onDeleteCleared());
        clearedHead.add(this._clearedTitle, { expand: true, x_fill: true, y_fill: false, y_align: St.Align.MIDDLE });
        clearedHead.add(this._deleteClearedButton, { y_fill: false, y_align: St.Align.MIDDLE });
        this._clearedList = new St.BoxLayout({ style_class: 'hush-cleared-list', vertical: true });
        this._clearedSection.add(clearedHead, { x_fill: true });
        this._clearedSection.add(this._clearedList, { x_fill: true });
        this._clearedSection.hide();
        scrollBox.add(this._clearedSection, { x_fill: true });
        this._scroll.add_actor(scrollBox);
        this.actor.add(this._scroll, { expand: true, x_fill: true, y_fill: true });

        // Empty state, centred where the list would be.
        this._emptyBin = new St.Bin({ style_class: 'hush-empty-bin', x_align: St.Align.MIDDLE, y_align: St.Align.MIDDLE, x_fill: false, y_fill: false });
        this._emptyBin.hide();
        this.actor.add(this._emptyBin, { expand: true, x_fill: true, y_fill: true });
        this._fillEmpty();

        // Footer: one text button, then icon buttons so it fits the minimum width.
        const footer = new St.BoxLayout({ style_class: 'hush-footer' });
        this._footer = footer;
        this._clearButton = new St.Button({ style_class: 'hush-footer-button', label: _('Clear all'), can_focus: true, reactive: true });
        this._clearButton.connect('clicked', () => this._cb.onClearAll());
        this._clearedButton = this._iconButton('hush-footer-icon', 'document-open-recent-symbolic', 16, _('Show cleared'), () => this._cb.onToggleCleared());
        this._clearedTooltip = this._clearedButton._hushTooltip;
        this._hushSettingsButton = this._iconButton('hush-footer-icon', 'emblem-system-symbolic', 16, _('Hush settings'), () => this._cb.onHushSettings());
        this._notifSettingsButton = this._iconButton('hush-footer-icon', 'preferences-system-notifications-symbolic', 16, _('Notification settings'), () => this._cb.onNotificationSettings());
        footer.add(this._clearButton, { expand: false, y_fill: false, y_align: St.Align.MIDDLE });
        footer.add(new St.Bin(), { expand: true });
        footer.add(this._clearedButton, { expand: false, y_fill: false, y_align: St.Align.MIDDLE });
        footer.add(this._hushSettingsButton, { expand: false, y_fill: false, y_align: St.Align.MIDDLE });
        footer.add(this._notifSettingsButton, { expand: false, y_fill: false, y_align: St.Align.MIDDLE });
        this.actor.add(footer, { x_fill: true });

        this.actor.connect('key-press-event', (a, ev) => this._onKeyPress(ev));
    }

    _iconButton(styleClass, iconName, size, tooltip, onClick) {
        const b = new St.Button({
            style_class: styleClass, reactive: true, can_focus: true,
            child: new St.Icon({ icon_name: iconName, icon_type: St.IconType.SYMBOLIC, icon_size: size })
        });
        b._hushTooltip = EdgeTooltip.create(b, tooltip);
        b.connect('clicked', onClick);
        return b;
    }

    // The empty state's content depends on Do Not Disturb.
    _fillEmpty() {
        const _ = this._;
        const old = this._emptyBin.get_child();
        if (old) old.destroy();
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
        this._emptyBin.set_child(box);
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
        // Rows and badges built before this open carry the previous accent.
        for (const views of [this._groupViews, this._clearedViews]) {
            for (const v of views.values()) {
                for (const rv of v.rows.values()) this._markRow(rv);
                this._updateCount(v);
            }
        }
    }

    _styleHeader() {
        this._header.set_style(this._dndActive
            ? 'background-color: ' + rgba(this._accent, 0.16) + '; border-bottom-color: ' + rgba(this._accent, 0.6) + ';'
            : null);
    }

    // ── motion ────────────────────────────────────────────────────────────

    // Cinnamon's own menus animate only with Effects → "Effects on menus".
    _animate() {
        if (this._destroyed || !this.actor.visible) return false;
        const wm = Main.wm;
        return !!(wm && wm.desktop_effects_menus);
    }

    // actor.ease() with the drawer's gate: off, or an unmapped actor, and the
    // target values are set at once with the callbacks run synchronously.
    _ease(actor, props) {
        if (this._animate() && actor.mapped) {
            actor.ease(props);
            return;
        }
        const p = Object.assign({}, props);
        const onComplete = p.onComplete, onStopped = p.onStopped;
        delete p.onComplete; delete p.onStopped; delete p.duration; delete p.delay; delete p.mode;
        actor.remove_all_transitions();
        actor.set(p);
        if (onStopped) onStopped(true);
        if (onComplete) onComplete();
    }

    // Width available to a child of `container` (its content box), for
    // measuring a row's wrapped height before it grows in.
    _contentWidth(container) {
        try {
            const box = container.get_theme_node().get_content_box(container.get_allocation_box());
            const w = box.x2 - box.x1;
            if (w > 0) return w;
        } catch (e) {
            // not allocated yet
        }
        return Math.max(this.width - 40, 100);
    }

    _edgeSign() {
        return this._side === 'left' ? -1 : 1;
    }

    _nextStagger() {
        return Math.min(this._staggerIndex++ * STAGGER_MS, STAGGER_CAP_MS);
    }

    // ── state in ──────────────────────────────────────────────────────────

    setDnd(state) {
        if (this._destroyed) return;
        const _ = this._;
        const s = state || {};
        const wasActive = this._dndActive;
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
        this._switch.actor.opacity = this._switchable ? 255 : 128;
        this._switchTooltip.set_text(this._switchable
            ? _('Turn Do Not Disturb on or off')
            : _('Turned off in System Settings → Notifications'));
        if (wasActive !== this._dndActive) this._fillEmpty();
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
            if (this.isOpen) this._relayout();
        }
    }

    setDirection(direction) {
        this.direction = direction;
        if (this.isOpen && !this._destroyed) this._relayout();
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
        this._apply();
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

    _apply() {
        const _ = this._;
        // A row with keyboard focus that goes away hands focus to the row
        // now at its place; kept rows keep theirs (their actors survive).
        const focusIndex = this.isOpen ? this._focusedRowIndex() : -1;

        let total = 0;
        for (const g of this._groups) total += g.records.length;
        let clearedTotal = 0;
        for (const g of this._cleared) clearedTotal += g.records.length;
        this._total = total;
        this._staggerIndex = 0;

        this._clearButton.reactive = total > 0;
        this._clearButton.opacity = total > 0 ? 255 : 128;
        const clearedUsable = clearedTotal > 0 || this._showCleared;
        this._clearedButton.reactive = clearedUsable;
        this._clearedButton.opacity = clearedUsable ? 255 : 128;
        this._clearedButton.checked = this._showCleared;
        this._clearedTooltip.set_text(this._showCleared ? _('Hide cleared') : _('Show cleared'));

        this._syncSection(this._list, this._groupViews, this._groups, false);

        if (this._showCleared) {
            this._clearedTitle.set_text(clearedTotal === 0 ? _('No cleared notifications')
                : (clearedTotal === 1 ? _('1 cleared notification') : _('%d cleared notifications').replace('%d', String(clearedTotal))));
            this._deleteClearedButton.visible = clearedTotal > 0;
            this._syncSection(this._clearedList, this._clearedViews, this._cleared, true);
            if (!this._clearedSection.visible) {
                this._clearedSection.opacity = 0;
                this._clearedSection.show();
                this._ease(this._clearedSection, { opacity: 255, duration: FADE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
            }
        } else if (this._clearedSection.visible || this._clearedViews.size) {
            this._clearedSection.hide();
            for (const v of this._clearedViews.values()) { try { v.box.destroy(); } catch (e) { /* gone */ } }
            this._clearedViews.clear();
            this._clearedList.destroy_all_children();
        }

        this._collectRows();
        this._syncEmpty();

        if (focusIndex >= 0 && this._focusedRowIndex() < 0 && this._rows.length > 0)
            this._rows[Math.min(focusIndex, this._rows.length - 1)].actor.grab_key_focus();
    }

    // The rows Up/Down walk: live rows, in list order, outside folded groups.
    _collectRows() {
        this._rows = [];
        for (const box of this._list.get_children()) {
            if (box._hushLeaving) continue;
            const v = this._groupViews.get(box._hushKey);
            if (!v || v.collapsed) continue;
            for (const a of v.rowsBox.get_children()) {
                if (a._hushLeaving) continue;
                const rv = v.rows.get(a._hushKey);
                if (rv) this._rows.push({ actor: rv.actor, record: rv.record });
            }
        }
    }

    // Empty state once nothing is listed and nothing is still sliding out.
    _syncEmpty() {
        if (this._destroyed) return;
        const pending = this._list.get_children().some(a => a._hushLeaving);
        const showEmpty = this._total === 0 && !this._showCleared && !pending;
        if (showEmpty) {
            if (this._emptyBin.visible) return;
            this._scroll.hide();
            this._emptyBin.opacity = 0;
            this._emptyBin.show();
            this._ease(this._emptyBin, { opacity: 255, duration: FADE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
        } else {
            if (this._emptyBin.visible) this._emptyBin.hide();
            if (!this._scroll.visible) this._scroll.show();
        }
    }

    // ── groups ────────────────────────────────────────────────────────────

    _syncSection(container, views, groups, cleared) {
        const desired = groups.map(g => ListDiff.groupKey(g, cleared));
        const current = container.get_children().map(a => ({ key: a._hushKey, leaving: !!a._hushLeaving }));
        const plan = ListDiff.plan(current, desired);
        const byKey = new Map();
        groups.forEach((g, i) => byKey.set(desired[i], g));

        for (const key of plan.leave) {
            const v = views.get(key);
            views.delete(key);
            if (v) this._leaveGroup(v);
        }
        for (const key of desired) {
            const g = byKey.get(key);
            let v = views.get(key);
            if (!v) {
                v = this._makeGroup(g, key, cleared);
                views.set(key, v);
                container.add(v.box, { x_fill: true });
                this._updateGroup(v, g);
                v.fresh = false;
                if (this._collapsed.has(key)) this._setCollapsed(v, true, false);
                this._enterActor(v.box, container, 0);
            } else {
                this._updateGroup(v, g);
            }
        }
        this._reorder(container, plan.order);
    }

    _reorder(container, order) {
        const byKey = new Map();
        for (const a of container.get_children()) byKey.set(a._hushKey, a);
        order.forEach((key, i) => {
            const a = byKey.get(key);
            if (a && container.get_child_at_index(i) !== a) container.set_child_at_index(a, i);
        });
    }

    // One application: a header (chevron, icon, name, count, controls) that
    // folds the group when clicked, then its rows. The mute and clear
    // buttons appear while the pointer is over the group; a muted
    // application shows a "Muted" pill instead, always visible.
    _makeGroup(group, key, cleared) {
        const box = new St.BoxLayout({ style_class: 'hush-group', vertical: true, reactive: !cleared, track_hover: !cleared });
        box._hushKey = key;
        if (cleared) box.opacity = DIM;

        const headerButton = new St.Button({ style_class: 'hush-group-header', reactive: true, can_focus: false, x_fill: true, y_fill: true });
        const hb = new St.BoxLayout({ style_class: 'hush-group-header-box' });
        const chevron = new St.Icon({ style_class: 'hush-group-chevron', icon_name: 'pan-down-symbolic', icon_type: St.IconType.SYMBOLIC, icon_size: 12, y_align: Clutter.ActorAlign.CENTER });
        chevron.set_pivot_point(0.5, 0.5);
        chevron.opacity = DIM;
        const iconBin = new St.Bin({ style_class: 'hush-group-icon', y_align: St.Align.MIDDLE });
        const label = new St.Label({ style_class: 'hush-group-label', y_align: Clutter.ActorAlign.CENTER });
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        const count = new St.Label({ style_class: 'hush-group-count', y_align: Clutter.ActorAlign.CENTER });
        const controls = new St.BoxLayout({ style_class: 'hush-group-controls' });
        hb.add(chevron, { y_fill: false, y_align: St.Align.MIDDLE });
        hb.add(iconBin, { y_fill: false, y_align: St.Align.MIDDLE });
        hb.add(label, { expand: true, x_fill: true, y_fill: false, y_align: St.Align.MIDDLE });
        hb.add(count, { y_fill: false, y_align: St.Align.MIDDLE });
        hb.add(controls, { y_fill: false, y_align: St.Align.MIDDLE });

        const view = {
            key, appId: group.appId, cleared, group, box, headerButton, chevron, iconBin, iconKey: null,
            label, count, controls, muted: null, hoverOnly: [],
            rowsBox: null, rows: new Map(), collapsed: false, fresh: true
        };
        headerButton.set_child(hb);
        headerButton.connect('clicked', () => this._toggleGroup(view));
        if (!cleared) {
            view.syncHover = () => {
                const on = box.hover || view.hoverOnly.some(b => b.has_key_focus());
                for (const b of view.hoverOnly) { b.opacity = on ? 255 : 0; b.reactive = on; }
            };
            box.connect('notify::hover', view.syncHover);
        }

        const rowsBox = new St.BoxLayout({ style_class: 'hush-group-rows', vertical: true });
        rowsBox.set_clip_to_allocation(true);
        view.rowsBox = rowsBox;
        box.add(headerButton, { x_fill: true });
        box.add(rowsBox, { x_fill: true });
        return view;
    }

    // The header's buttons depend on whether the application is muted.
    _buildControls(view, muted) {
        const _ = this._;
        view.controls.destroy_all_children();
        view.hoverOnly = [];
        view.muted = muted;
        if (muted) {
            const pillBox = new St.BoxLayout({ style_class: 'hush-muted-pill-box' });
            pillBox.add(new St.Icon({ icon_name: 'notifications-disabled-symbolic', icon_type: St.IconType.SYMBOLIC, icon_size: 12 }), { y_fill: false, y_align: St.Align.MIDDLE });
            pillBox.add(new St.Label({ text: _('Muted'), y_align: Clutter.ActorAlign.CENTER }), { y_fill: false, y_align: St.Align.MIDDLE });
            const pill = new St.Button({ style_class: 'hush-muted-pill', reactive: true, can_focus: true, child: pillBox });
            EdgeTooltip.create(pill, _('Unmute this application'));
            pill.connect('clicked', () => this._cb.onMuteToggle(view.group));
            view.controls.add(pill, { y_fill: false, y_align: St.Align.MIDDLE });
        } else {
            const mute = this._iconButton('hush-group-button', 'preferences-system-notifications-symbolic', 14, _('Mute this application'), () => this._cb.onMuteToggle(view.group));
            view.hoverOnly.push(mute);
            view.controls.add(mute, { y_fill: false, y_align: St.Align.MIDDLE });
        }
        const clear = this._iconButton('hush-group-button', 'window-close-symbolic', 14, _('Clear this application'), () => this._cb.onClearGroup(view.group));
        view.hoverOnly.push(clear);
        view.controls.add(clear, { y_fill: false, y_align: St.Align.MIDDLE });
        for (const b of view.hoverOnly) {
            b.connect('key-focus-in', view.syncHover);
            b.connect('key-focus-out', view.syncHover);
        }
        view.syncHover();
    }

    _updateGroup(view, group) {
        view.group = group;
        const first = group.records[0];
        const iconKey = first ? (first.appIcon || first.imagePath || first.desktopEntry || group.appId || '') : '';
        if (iconKey !== view.iconKey) {
            view.iconKey = iconKey;
            let icon = null;
            try { icon = first ? this._iconFor(first, 20) : null; } catch (e) { icon = null; }
            const old = view.iconBin.get_child();
            if (old) old.destroy();
            if (icon) view.iconBin.set_child(icon);
            view.iconBin.visible = !!icon;
        }
        view.label.set_text(group.appLabel || group.appId);
        if (!view.cleared) {
            const muted = this._muted.has(group.appId);
            if (muted !== view.muted) this._buildControls(view, muted);
        }

        // Rows.
        const desired = group.records.map(r => ListDiff.rowKey(r, view.cleared));
        const current = view.rowsBox.get_children().map(a => ({ key: a._hushKey, leaving: !!a._hushLeaving }));
        const plan = ListDiff.plan(current, desired);
        for (const key of plan.leave) {
            const rv = view.rows.get(key);
            view.rows.delete(key);
            if (rv) this._leaveRow(rv, this._nextStagger(), true);
        }
        group.records.forEach((rec, i) => {
            const key = desired[i];
            let rv = view.rows.get(key);
            if (!rv) {
                rv = this._makeRow(rec, view.cleared, key);
                view.rows.set(key, rv);
                view.rowsBox.add(rv.actor, { x_fill: true });
                if (!view.fresh) this._enterActor(rv.actor, view.rowsBox, ENTER_OFFSET);
            } else {
                this._renderRow(rv, rec);
            }
        });
        this._reorder(view.rowsBox, plan.order);
        this._updateCount(view);
    }

    // The count shows with more than one entry, and always while folded
    // (how many are hidden), in the accent colour while any of them is new.
    _updateCount(view) {
        const records = view.group.records;
        const n = records.length;
        const unread = view.collapsed && !view.cleared && records.some(r => this._isFresh(r));
        view.count.set_text(String(n));
        view.count.visible = view.collapsed || n > 1;
        view.count.opacity = unread ? 255 : DIM;
        if (unread) {
            view.count.add_style_class_name('hush-group-count-unread');
            view.count.set_style('background-color: ' + rgba(this._accent, 0.75) + ';');
        } else {
            view.count.remove_style_class_name('hush-group-count-unread');
            view.count.set_style(null);
        }
    }

    _toggleGroup(view) {
        if (this._destroyed || view.box._hushLeaving) return;
        const collapsed = !view.collapsed;
        if (collapsed) this._collapsed.add(view.key); else this._collapsed.delete(view.key);
        this._setCollapsed(view, collapsed, true);
        // A focused row that just folded away gives focus back to the drawer.
        const focus = global.stage.get_key_focus();
        if (collapsed && focus && this._contains(view.rowsBox, focus)) this.actor.grab_key_focus();
    }

    _setCollapsed(view, collapsed, animate) {
        view.collapsed = collapsed;
        const rows = view.rowsBox;
        const angle = collapsed ? -90 : 0;
        const animating = animate && this._animate() && rows.mapped;
        if (animating) this._ease(view.chevron, { rotation_angle_z: angle, duration: FOLD_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
        else view.chevron.rotation_angle_z = angle;
        rows.remove_all_transitions();
        if (collapsed) {
            if (!animating) {
                rows.hide();
            } else {
                rows.set_height(rows.get_height());
                rows.ease({
                    height: 0, opacity: 0, duration: FOLD_MS, mode: Clutter.AnimationMode.EASE_IN_QUAD,
                    onComplete: () => { if (view.collapsed) rows.hide(); }
                });
            }
        } else {
            rows.show();
            rows.set_height(-1);
            if (!animating) {
                rows.opacity = 255;
            } else {
                const [, nat] = rows.get_preferred_height(this._contentWidth(view.box));
                rows.set_height(0);
                rows.opacity = 0;
                rows.ease({
                    height: nat, opacity: 255, duration: FOLD_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => { if (!view.collapsed) rows.set_height(-1); }
                });
            }
        }
        this._updateCount(view);
        if (!view.cleared) this._collectRows();
    }

    _resetFolds() {
        this._collapsed.clear();
        for (const views of [this._groupViews, this._clearedViews]) {
            for (const v of views.values()) if (v.collapsed) this._setCollapsed(v, false, false);
        }
    }

    // A whole group going away: its rows slide out in the cascade, then the
    // box closes up behind them.
    _leaveGroup(view) {
        const box = view.box;
        box._hushLeaving = true;
        box._hushKey = 'leaving:' + (++this._leaveSeq);
        box.reactive = false;
        view.headerButton.reactive = false;
        for (const b of view.hoverOnly) b.reactive = false;
        let lastDelay = 0;
        if (!view.collapsed) {
            for (const rv of view.rows.values()) { lastDelay = this._nextStagger(); this._leaveRow(rv, lastDelay, false); }
        }
        view.rows.clear();
        const done = () => {
            try { box.destroy(); } catch (e) { /* gone */ }
            this._syncEmpty();
        };
        if (!this._animate() || !box.mapped) { done(); return; }
        box.set_clip_to_allocation(true);
        box.set_height(box.get_height());
        box.ease({
            height: 0, opacity: 0, delay: lastDelay + LEAVE_MS * 0.5, duration: COLLAPSE_MS,
            mode: Clutter.AnimationMode.EASE_IN_QUAD, onStopped: () => done()
        });
    }

    // ── rows ──────────────────────────────────────────────────────────────

    _isFresh(record) {
        return record.state === 'unread' || this._fresh.has(record.id);
    }

    _makeRow(record, cleared, key) {
        const actor = new St.BoxLayout({ style_class: 'hush-row', vertical: true, reactive: !cleared, track_hover: !cleared, can_focus: !cleared });
        actor._hushKey = key;
        if (cleared) actor.add_style_class_name('hush-row-cleared');
        const view = { key, actor, record, cleared, sig: null, close: null, time: null };
        if (!cleared) {
            // × is quiet until the row is hovered or focused.
            view.syncClose = () => {
                const c = view.close;
                if (c) c.opacity = (actor.hover || actor.has_key_focus() || c.hover || c.has_key_focus()) ? 255 : CLOSE_IDLE;
            };
            actor.connect('notify::hover', view.syncClose);
            actor.connect('key-focus-in', view.syncClose);
            actor.connect('key-focus-out', view.syncClose);
            actor.connect('button-release-event', (a, ev) => {
                if (ev.get_button() !== 1 || actor._hushLeaving) return Clutter.EVENT_PROPAGATE;
                if (ev.get_source() instanceof St.Button) return Clutter.EVENT_PROPAGATE;
                this._cb.onActivate(view.record);
                return Clutter.EVENT_STOP;
            });
        }
        this._renderRow(view, record);
        return view;
    }

    // Content is rebuilt only when what it shows changed (ListDiff.signature);
    // the unread and critical marks and the time are updated every time.
    _renderRow(view, record) {
        view.record = record;
        const sig = ListDiff.signature(record);
        if (sig !== view.sig) {
            view.sig = sig;
            view.actor.destroy_all_children();
            this._rowContent(view, record);
        } else if (view.time) {
            view.time.set_text(TimeFmt.relative(record.time, Date.now(), this._));
        }
        this._markRow(view);
    }

    _markRow(view) {
        const actor = view.actor;
        const record = view.record;
        const fresh = !view.cleared && this._isFresh(record);
        actor.remove_style_class_name('hush-critical');
        actor.remove_style_class_name('hush-unread');
        actor.set_style(null);
        if (record.urgency === 2) {
            actor.add_style_class_name('hush-critical');
        } else if (fresh) {
            actor.add_style_class_name('hush-unread');
            actor.set_style('border-left-color: ' + rgba(this._accent, 1) + ';');
        }
    }

    _rowContent(view, record) {
        const cleared = view.cleared;
        const row = view.actor;

        const top = new St.BoxLayout({ style_class: 'hush-row-top' });
        const title = new St.Label({ style_class: 'hush-row-title', y_align: Clutter.ActorAlign.CENTER });
        title.clutter_text.set_markup('<b>' + Markup.escape(Markup.plain(record.summary || '')) + '</b>');
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        const time = new St.Label({ style_class: 'hush-row-time', reactive: true, text: TimeFmt.relative(record.time, Date.now(), this._), y_align: Clutter.ActorAlign.CENTER });
        time.opacity = DIM;
        EdgeTooltip.create(time, TimeFmt.exact(record.time));
        view.time = time;
        top.add(title, { expand: true, x_fill: true, y_fill: false, y_align: St.Align.MIDDLE });
        top.add(time, { y_fill: false, y_align: St.Align.MIDDLE });
        view.close = null;
        if (!cleared) {
            const close = new St.Button({
                style_class: 'hush-row-close', reactive: true, can_focus: true,
                child: new St.Icon({ icon_name: 'window-close-symbolic', icon_type: St.IconType.SYMBOLIC, icon_size: 14 })
            });
            close.connect('clicked', () => { if (!row._hushLeaving) this._cb.onDismiss(view.record); });
            close.connect('notify::hover', view.syncClose);
            view.close = close;
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
                b.connect('clicked', () => { if (!row._hushLeaving) this._cb.onAction(view.record, a.key); });
                box.add(b);
            }
            row.add(box, { x_fill: true });
        }
        if (view.syncClose) view.syncClose();
    }

    // A new row or group grows from nothing and fades in, sliding a little
    // from the edge side; instant when the drawer is closed or folded.
    _enterActor(actor, container, offset) {
        if (!this._animate() || !actor.mapped) return;
        const [, nat] = actor.get_preferred_height(this._contentWidth(container));
        actor.set_clip_to_allocation(true);
        actor.set_height(0);
        actor.opacity = 0;
        actor.translation_x = offset * this._edgeSign();
        actor.ease({
            height: nat, duration: ROW_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => { if (!actor._hushLeaving) actor.set_height(-1); }
        });
        actor.ease({ opacity: 255, translation_x: 0, duration: ROW_MS + 60, mode: Clutter.AnimationMode.EASE_OUT_CUBIC });
    }

    // A dismissed row slides out toward the screen edge; with `collapse` the
    // gap it leaves closes up too (a group that stays), otherwise its group
    // is closing behind it.
    _leaveRow(view, delay, collapse) {
        const actor = view.actor;
        actor._hushLeaving = true;
        actor._hushKey = 'leaving:' + (++this._leaveSeq);
        actor.reactive = false;
        actor.can_focus = false;
        const done = () => {
            try { actor.destroy(); } catch (e) { /* gone */ }
            this._syncEmpty();
        };
        if (!this._animate() || !actor.mapped) { done(); return; }
        actor.remove_all_transitions();
        actor.set_clip_to_allocation(true);
        actor.set_height(actor.get_height());
        const dx = this._edgeSign() * Math.max(actor.get_width(), 1);
        actor.ease({
            translation_x: dx, opacity: 0, delay, duration: LEAVE_MS, mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: finished => {
                if (!finished || !collapse) { done(); return; }
                actor.ease({ height: 0, duration: COLLAPSE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD, onStopped: () => done() });
            }
        });
    }

    _refreshTimes() {
        const now = Date.now();
        for (const views of [this._groupViews, this._clearedViews]) {
            for (const v of views.values()) {
                for (const rv of v.rows.values()) if (rv.time) rv.time.set_text(TimeFmt.relative(rv.record.time, now, this._));
            }
        }
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

    _geometry() {
        const index = this._monitorIndex();
        const { mon, rect } = this._workArea(index);
        const side = this._resolveSide(mon);
        const width = Math.min(this.width, rect.width);
        return {
            side, width, height: rect.height, y: rect.y, rect,
            targetX: side === 'left' ? rect.x : rect.x + rect.width - width,
            hiddenX: side === 'left' ? rect.x - width : rect.x + rect.width
        };
    }

    // Border and shadow on the inner edge only.
    _setSide(side) {
        this._side = side;
        this.actor.remove_style_class_name(side === 'left' ? 'hush-side-right' : 'hush-side-left');
        this.actor.add_style_class_name('hush-side-' + side);
    }

    // Width or edge changed while open: snap to the new place.
    _relayout() {
        const g = this._geometry();
        this._setSide(g.side);
        this.actor.remove_all_transitions();
        this.actor.set_size(g.width, g.height);
        this.actor.set_position(g.targetX, g.y);
        this.actor.opacity = 255;
    }

    // ── open / close ──────────────────────────────────────────────────────

    open() {
        if (this._destroyed || this.isOpen) return false;
        this.isOpen = true;
        const g = this._geometry();
        this._setSide(g.side);
        const stillClosing = this.actor.visible;   // reopened mid-slide: continue from here
        this.actor.remove_all_transitions();
        this.actor.set_size(g.width, g.height);
        this.actor.set_y(g.y);
        if (!stillClosing) {
            this.actor.set_x(g.hiddenX);
            this.actor.opacity = 0;
            this.actor.show();
        }
        this._applyTheme();
        this._ease(this.actor, { x: g.targetX, opacity: 255, duration: OPEN_MS, mode: Clutter.AnimationMode.EASE_OUT_CUBIC });
        this._grab();
        this._cb.onOpened();
        this._refreshTimes();
        this._startTimeTimer();
        return true;
    }

    close() {
        if (this._destroyed || !this.isOpen) return false;
        this.isOpen = false;
        // Rows marked new keep the mark only while the drawer is open.
        this._fresh = new Set();
        for (const v of this._groupViews.values()) {
            for (const rv of v.rows.values()) this._markRow(rv);
            this._updateCount(v);
        }
        this._stopTimeTimer();
        this._ungrab();
        const g = this._geometry();
        const hiddenX = this._side === 'left' ? g.rect.x - this.actor.width : g.rect.x + g.rect.width;
        this.actor.remove_all_transitions();
        this._ease(this.actor, {
            x: hiddenX, opacity: 0, duration: CLOSE_MS, mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                if (this.isOpen || this._destroyed) return;
                this.actor.hide();
                this.actor.opacity = 255;
                this._resetFolds();
            }
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
    // Up/Down move between rows (folded groups are skipped), Enter opens,
    // Delete dismisses, Tab walks the buttons, Escape closes.
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
        this._groupViews.clear();
        this._clearedViews.clear();
        this._collapsed.clear();
        try { this.actor.remove_all_transitions(); } catch (e) { /* ignore */ }
        try { Main.layoutManager.removeChrome(this.actor); } catch (e) { /* ignore */ }
        try { this.actor.destroy(); } catch (e) { /* ignore */ }
        this.actor = null;
    }
}
