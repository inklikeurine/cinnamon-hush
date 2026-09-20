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
//       onMuteToggle: group => …, onToggleCleared: () => …, onDeleteCleared: () => …
//   });
//   drawer.setDnd({ active, label, switchable });
//   drawer.setGroups(history.groups(), history.unreadCount(), {
//       muted: Set of app ids, cleared: history.groups(history.cleared()), showCleared: bool });
//   drawer.setNotice('Notification capture unavailable …') / setNotice(null)
//   drawer.open() / close() / toggle(); drawer.isOpen
//   drawer.destroy()   // releases the modal grab and the chrome actor

const Main = imports.ui.main;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const Pango = imports.gi.Pango;
const PopupMenu = imports.ui.popupMenu;
const Tooltips = imports.ui.tooltips;

const Markup = require('./modules/Markup');

const SLIDE_MS = 200;
const PanelLoc = Object.freeze({ top: 0, bottom: 1, left: 2, right: 3 });

function fmtTime(ms) {
    try {
        return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
        return '';
    }
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
            onToggleCleared: o.onToggleCleared || (() => {}),
            onDeleteCleared: o.onDeleteCleared || (() => {})
        };

        this.isOpen = false;
        this._modal = false;
        this._capturedId = 0;
        this._destroyed = false;
        this._side = 'right';
        this._groups = [];
        this._unread = 0;
        this._muted = new Set();
        this._cleared = [];
        this._showCleared = false;

        this._build();
        Main.layoutManager.addChrome(this.actor, { visibleInFullscreen: false, affectsStruts: false, affectsInputRegion: true });
        this.actor.hide();
    }

    // ── actors ────────────────────────────────────────────────────────────

    _build() {
        const _ = this._;
        this.actor = new St.BoxLayout({ style_class: 'hush-drawer', vertical: true, reactive: true, width: this.width });

        // Header: DND switch + status line.
        const header = new St.BoxLayout({ style_class: 'hush-header', vertical: true });
        this._header = header;
        const dndRow = new St.BoxLayout({ style_class: 'hush-dnd-row' });
        const dndLabel = new St.Label({ style_class: 'hush-dnd-label', text: _('Do Not Disturb'), y_align: Clutter.ActorAlign.CENTER });
        this._switch = new PopupMenu.Switch(false);
        this._switchButton = new St.Button({ style_class: 'hush-dnd-switch', child: this._switch.actor, y_align: Clutter.ActorAlign.CENTER });
        this._switchButton.connect('clicked', () => this._cb.onDndToggle());
        dndRow.add(dndLabel, { expand: true, x_fill: true, y_fill: false, y_align: St.Align.MIDDLE });
        dndRow.add(this._switchButton, { expand: false, x_fill: false, y_fill: false, y_align: St.Align.MIDDLE });
        const statusRow = new St.BoxLayout({ style_class: 'hush-status-row' });
        this._statusIcon = new St.Icon({ style_class: 'hush-status-icon', icon_name: 'notifications-disabled-symbolic', icon_type: St.IconType.SYMBOLIC, icon_size: 16, y_align: Clutter.ActorAlign.CENTER });
        this._statusIcon.hide();
        this._status = new St.Label({ style_class: 'hush-status', text: _('Off'), y_align: Clutter.ActorAlign.CENTER });
        this._status.clutter_text.line_wrap = true;
        this._status.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        statusRow.add(this._statusIcon, { y_fill: false, y_align: St.Align.MIDDLE });
        statusRow.add(this._status, { expand: true, x_fill: true, y_fill: false, y_align: St.Align.MIDDLE });
        header.add(dndRow, { x_fill: true });
        header.add(statusRow, { x_fill: true });
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

        // Footer.
        const footer = new St.BoxLayout({ style_class: 'hush-footer' });
        this._clearButton = this._footerButton(_('Clear all'), () => this._cb.onClearAll());
        this._clearedButton = this._footerButton(_('Show cleared'), () => this._cb.onToggleCleared());
        const hushSettings = this._footerButton(_('Hush settings'), () => this._cb.onHushSettings());
        const notifSettings = this._footerButton(_('Notification settings'), () => this._cb.onNotificationSettings());
        footer.add(this._clearButton, { expand: false });
        footer.add(this._clearedButton, { expand: false });
        footer.add(new St.Bin(), { expand: true });
        footer.add(hushSettings, { expand: false });
        footer.add(notifSettings, { expand: false });
        this.actor.add(footer, { x_fill: true });

        this.actor.connect('key-press-event', (a, ev) => this._onKeyPress(ev));
    }

    _footerButton(label, onClick) {
        const b = new St.Button({ style_class: 'hush-footer-button', label, can_focus: true, reactive: true });
        b.connect('clicked', onClick);
        return b;
    }

    // ── state in ──────────────────────────────────────────────────────────

    setDnd(state) {
        if (this._destroyed) return;
        const s = state || {};
        this._switch.setToggleState(!!s.active);
        this._status.set_text(s.label || '');
        if (s.active) {
            this._header.add_style_class_name('hush-header-on');
            this._status.add_style_class_name('hush-status-on');
            this._statusIcon.show();
        } else {
            this._header.remove_style_class_name('hush-header-on');
            this._status.remove_style_class_name('hush-status-on');
            this._statusIcon.hide();
        }
        this._switchButton.reactive = s.switchable !== false;
        this._switchButton.opacity = s.switchable === false ? 128 : 255;
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

    _rebuild() {
        this._list.destroy_all_children();
        const _ = this._;
        let total = 0;
        for (const g of this._groups) total += g.records.length;
        let clearedTotal = 0;
        for (const g of this._cleared) clearedTotal += g.records.length;
        this._clearButton.reactive = total > 0;
        this._clearButton.opacity = total > 0 ? 255 : 128;
        this._clearedButton.label = this._showCleared ? _('Hide cleared') : _('Show cleared');
        this._clearedButton.reactive = clearedTotal > 0 || this._showCleared;
        this._clearedButton.opacity = (clearedTotal > 0 || this._showCleared) ? 255 : 128;

        if (total === 0) {
            const empty = new St.Label({ style_class: 'hush-empty', text: _('No notifications') });
            this._list.add(empty, { x_fill: true });
        }
        for (const g of this._groups) {
            const box = new St.BoxLayout({ style_class: 'hush-group', vertical: true });
            box.add(this._buildGroupHeader(g, false), { x_fill: true });
            for (const rec of g.records) box.add(this._buildRow(rec, false), { x_fill: true });
            this._list.add(box, { x_fill: true });
        }
        if (this._showCleared) {
            const section = new St.BoxLayout({ style_class: 'hush-cleared-section', vertical: true });
            const head = new St.BoxLayout({ style_class: 'hush-cleared-header' });
            const title = new St.Label({ style_class: 'hush-cleared-title', y_align: Clutter.ActorAlign.CENTER,
                text: clearedTotal === 0 ? _('No cleared notifications') : (clearedTotal === 1 ? _('1 cleared notification') : _('%d cleared notifications').replace('%d', String(clearedTotal))) });
            head.add(title, { expand: true, x_fill: true, y_fill: false, y_align: St.Align.MIDDLE });
            if (clearedTotal > 0) {
                const del = new St.Button({ style_class: 'hush-footer-button', label: _('Delete cleared'), can_focus: true, reactive: true });
                del.connect('clicked', () => this._cb.onDeleteCleared());
                head.add(del, { y_fill: false, y_align: St.Align.MIDDLE });
            }
            section.add(head, { x_fill: true });
            for (const g of this._cleared) {
                const box = new St.BoxLayout({ style_class: 'hush-group hush-group-cleared', vertical: true });
                box.add(this._buildGroupHeader(g, true), { x_fill: true });
                for (const rec of g.records) box.add(this._buildRow(rec, true), { x_fill: true });
                section.add(box, { x_fill: true });
            }
            this._list.add(section, { x_fill: true });
        }
    }

    _buildGroupHeader(group, cleared) {
        const _ = this._;
        const header = new St.BoxLayout({ style_class: 'hush-group-header' });
        const first = group.records[0];
        let icon = null;
        try { icon = this._iconFor(first, 20); } catch (e) { icon = null; }
        if (icon) header.add(icon, { y_align: St.Align.MIDDLE, y_fill: false });
        const muted = this._muted.has(group.appId);
        const label = new St.Label({ style_class: 'hush-group-label', text: (group.appLabel || group.appId) + (muted ? ' \u2014 ' + _('muted') : ''), y_align: Clutter.ActorAlign.CENTER });
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        header.add(label, { expand: true, x_fill: true, y_fill: false, y_align: St.Align.MIDDLE });
        if (group.records.length > 1) {
            const count = new St.Label({ style_class: 'hush-group-count', text: String(group.records.length), y_align: Clutter.ActorAlign.CENTER });
            header.add(count, { y_fill: false, y_align: St.Align.MIDDLE });
        }
        if (!cleared) {
            const mute = new St.Button({
                style_class: 'hush-mute-button' + (muted ? ' hush-muted' : ''), reactive: true, can_focus: true,
                child: new St.Icon({ icon_name: muted ? 'notifications-disabled-symbolic' : 'preferences-system-notifications-symbolic', icon_type: St.IconType.SYMBOLIC, icon_size: 14 })
            });
            new Tooltips.Tooltip(mute, muted ? _('Unmute this application') : _('Mute this application'));
            mute.connect('clicked', () => this._cb.onMuteToggle(group));
            header.add(mute, { y_fill: false, y_align: St.Align.MIDDLE });
        }
        return header;
    }

    _buildRow(record, cleared) {
        const row = new St.BoxLayout({ style_class: 'hush-row', vertical: true, reactive: !cleared, track_hover: !cleared, can_focus: !cleared });
        if (cleared) row.add_style_class_name('hush-row-cleared');
        if (record.state === 'unread') row.add_style_class_name('hush-unread');
        if (record.urgency === 2) row.add_style_class_name('hush-critical');

        const top = new St.BoxLayout({ style_class: 'hush-row-top' });
        const title = new St.Label({ style_class: 'hush-row-title', y_align: Clutter.ActorAlign.CENTER });
        title.clutter_text.set_markup('<b>' + Markup.escape(Markup.plain(record.summary || '')) + '</b>');
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        const time = new St.Label({ style_class: 'hush-row-time', text: fmtTime(record.time), y_align: Clutter.ActorAlign.CENTER });
        const close = new St.Button({
            style_class: 'hush-row-close', reactive: true, can_focus: true,
            child: new St.Icon({ icon_name: 'window-close-symbolic', icon_type: St.IconType.SYMBOLIC, icon_size: 14 })
        });
        close.connect('clicked', () => this._cb.onDismiss(record));
        top.add(title, { expand: true, x_fill: true, y_fill: false, y_align: St.Align.MIDDLE });
        top.add(time, { y_fill: false, y_align: St.Align.MIDDLE });
        if (!cleared) top.add(close, { y_fill: false, y_align: St.Align.MIDDLE });
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
        row.connect('button-release-event', (actor, ev) => {
            if (ev.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
            const src = ev.get_source();
            if (src instanceof St.Button) return Clutter.EVENT_PROPAGATE;
            this._cb.onActivate(record);
            return Clutter.EVENT_STOP;
        });
        return row;
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
        this._place(true);
        this._grab();
        this._cb.onOpened();
        return true;
    }

    close() {
        if (this._destroyed || !this.isOpen) return false;
        this.isOpen = false;
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
        if (type === Clutter.EventType.KEY_PRESS) {
            if (ev.get_key_symbol() === Clutter.KEY_Escape) { this.close(); return Clutter.EVENT_STOP; }
            return Clutter.EVENT_PROPAGATE;
        }
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

    _onKeyPress(ev) {
        if (ev.get_key_symbol() === Clutter.KEY_Escape) { this.close(); return Clutter.EVENT_STOP; }
        return Clutter.EVENT_PROPAGATE;
    }

    destroy() {
        if (this._destroyed) return;
        this.isOpen = false;
        this._ungrab();
        this._destroyed = true;
        try { this.actor.remove_all_transitions(); } catch (e) { /* ignore */ }
        try { Main.layoutManager.removeChrome(this.actor); } catch (e) { /* ignore */ }
        try { this.actor.destroy(); } catch (e) { /* ignore */ }
        this.actor = null;
    }
}
