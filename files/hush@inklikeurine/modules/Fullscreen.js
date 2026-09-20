// Fullscreen.js — "a window is fullscreen": true while any monitor (or only
// the primary one, per `scope`) has a fullscreen window. Uses what the
// layout manager already tracks (Main.layoutManager.monitors[i].inFullscreen)
// and Muffin's 'in-fullscreen-changed' signal. Shell-only (imports.ui).
//
//   const fs = new Fullscreen({ scope: 'any' | 'primary' });
//   fs.active; fs.setScope('primary'); fs.onChanged(active => …); fs.destroy()

const Main = imports.ui.main;

class Fullscreen {
    constructor(opts) {
        const o = opts || {};
        this.scope = o.scope === 'primary' ? 'primary' : 'any';
        this.active = false;
        this._handlers = new Map();
        this._nextId = 1;
        this._signals = [];
        this._destroyed = false;
        this._signals.push([global.display, global.display.connect('in-fullscreen-changed', () => this._update())]);
        this._signals.push([Main.layoutManager, Main.layoutManager.connect('monitors-changed', () => this._update())]);
        this._update();
    }

    setScope(scope) {
        this.scope = scope === 'primary' ? 'primary' : 'any';
        this._update();
    }

    onChanged(cb) {
        if (this._destroyed) return 0;
        const id = this._nextId++;
        this._handlers.set(id, cb);
        return id;
    }

    disconnect(id) { this._handlers.delete(id); }

    _compute() {
        try {
            if (this.scope === 'primary') {
                const p = Main.layoutManager.primaryMonitor;
                return !!(p && p.inFullscreen);
            }
            return (Main.layoutManager.monitors || []).some(m => m && m.inFullscreen);
        } catch (e) {
            return false;
        }
    }

    _update() {
        if (this._destroyed) return;
        const active = this._compute();
        if (active === this.active) return;
        this.active = active;
        for (const cb of Array.from(this._handlers.values())) {
            try { cb(active); } catch (e) { /* listener's problem */ }
        }
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this._handlers.clear();
        for (const [obj, id] of this._signals) { try { obj.disconnect(id); } catch (e) { /* gone */ } }
        this._signals = [];
        this.active = false;
    }
}
