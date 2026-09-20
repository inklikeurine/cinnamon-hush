// DndState.js — combines every reason Do Not Disturb can be on into one
// state with a status line. Pure; headless-tested in dndstate.test.js.
//
// Hush owns its DND (proposal §14 D8): it never writes
// org.cinnamon.desktop.notifications display-notifications. That key being
// false is just one more reason ('external'), which the applet feeds in.
//
//   const dnd = new DndState();
//   dnd.set('manual', true);                      // returns true when active/reason changed
//   dnd.set('schedule', true, { until: '07:00' });
//   dnd.active    → true
//   dnd.reason    → 'manual'      (highest-priority active reason)
//   dnd.label(_)  → 'On'          (_ = gettext function; pure fallback: identity)
//   dnd.reasons() → ['manual', 'schedule']
//
// Priority (what the status line names when several are active):
//   manual, schedule, fullscreen, recording, inhibitor, external
//
// The user's switch: userOn() sets 'manual'; userOff() clears 'manual' and
// *suppresses* every other active reason Hush controls — the reason is
// still held (the window is still fullscreen, the schedule still running)
// but no longer counts, until set(reason, false) ends it or unsuppress()
// is called (the applet does that at the next schedule boundary). 'external'
// (System Settings' own key) is never suppressed; Hush does not write it.

const ORDER = ['manual', 'schedule', 'fullscreen', 'recording', 'inhibitor', 'external'];

var Reasons = Object.freeze(ORDER.slice());

class DndState {
    constructor() {
        this._active = new Map();      // reason → detail object (counts)
        this._held = new Map();        // reason → detail object (true in the world, maybe suppressed)
        this._suppressed = new Set();  // reasons the user switched off while held
    }

    // Returns true when the visible state (active set) changed.
    set(reason, active, detail) {
        if (ORDER.indexOf(reason) < 0) return false;
        const before = this._snapshot();
        if (active) {
            const d = detail || {};
            this._held.set(reason, d);
            if (!this._suppressed.has(reason)) this._active.set(reason, d);
        } else {
            this._held.delete(reason);
            this._active.delete(reason);
            this._suppressed.delete(reason);
        }
        return before !== this._snapshot();
    }

    isHeld(reason) { return this._held.has(reason); }

    isSuppressed(reason) { return this._suppressed.has(reason); }

    suppress(reason) {
        if (reason === 'external' || !this._held.has(reason)) return false;
        this._suppressed.add(reason);
        return this._active.delete(reason);
    }

    unsuppress(reason) {
        if (!this._suppressed.delete(reason)) return false;
        if (this._held.has(reason)) { this._active.set(reason, this._held.get(reason)); return true; }
        return false;
    }

    userOn() {
        return this.set('manual', true);
    }

    userOff() {
        let changed = this.set('manual', false);
        for (const r of this.reasons()) if (this.suppress(r)) changed = true;
        return changed;
    }

    is(reason) {
        return this._active.has(reason);
    }

    detail(reason) {
        return this._active.get(reason) || null;
    }

    get active() {
        return this._active.size > 0;
    }

    get reason() {
        for (const r of ORDER) if (this._active.has(r)) return r;
        return null;
    }

    reasons() {
        return ORDER.filter(r => this._active.has(r));
    }

    // Whether the user can turn DND off with the switch right now: only
    // the reasons Hush controls itself can be overridden. 'external' is
    // System Settings' key, which Hush never writes.
    get switchable() {
        const r = this.reason;
        return r === null || r !== 'external';
    }

    _snapshot() {
        return this.reasons().join(',');
    }

    label(gettext) {
        const _ = typeof gettext === 'function' ? gettext : (s => s);
        const r = this.reason;
        const d = this.detail(r) || {};
        switch (r) {
            case null: return _('Off');
            case 'manual': return _('On');
            case 'schedule': return d.until ? _('On until %s (schedule)').replace('%s', d.until) : _('On (schedule)');
            case 'fullscreen': return _('On — fullscreen window');
            case 'recording': return _('On — call or recording in progress');
            case 'inhibitor': return d.app ? _('On — %s is running an inhibitor').replace('%s', d.app) : _('On — an app is running an inhibitor');
            case 'external': return _('On — set in System Settings');
            default: return _('On');
        }
    }
}
