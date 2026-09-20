// Recording.js — "a call or recording is in progress": true while any
// application holds a recording stream on the sound server (a
// Cvc.MixerSourceOutput), which is what a Discord call, a screen share
// with audio, OBS with a microphone source or any voice recorder does.
// Heuristic on X11 (nothing says "the screen is being captured"): meters
// such as pavucontrol's peak detection are filtered out; anything else
// that opens the microphone counts. Cvc is GObject-introspected, so this
// runs under plain `cjs` too (recording.test.js, read-only).
//
//   const rec = new Recording();          // opens its own Cvc.MixerControl
//   rec.ready                             // the mixer reached READY
//   rec.active                            // a qualifying source output exists
//   rec.streams                           // [{ index, name, icon }] qualifying
//   rec.onChanged(active => …)            // handler id
//   rec.destroy()

let Cvc = null;
try { Cvc = imports.gi.Cvc; } catch (e) { Cvc = null; }

// Streams that only listen to level, not record: pavucontrol,
// cinnamon-settings' input test, GNOME's, and PipeWire's own monitors.
const IGNORE_NAME = /peak detect|level meter|volume control|monitor of/i;

function _qualifies(stream) {
    if (!stream) return false;
    if (Cvc && !(stream instanceof Cvc.MixerSourceOutput)) return false;
    if (stream.is_event_stream || stream.is_virtual) return false;
    if (IGNORE_NAME.test(String(stream.name || '')) || IGNORE_NAME.test(String(stream.description || ''))) return false;
    return true;
}

class Recording {
    constructor(opts) {
        const o = opts || {};
        this._handlers = new Map();
        this._nextId = 1;
        this._signals = [];
        this._streams = new Map();       // Cvc stream id → { index, name, icon }
        this._control = null;
        this._destroyed = false;
        this.ready = false;
        this.available = Cvc !== null;
        this.active = false;
        if (!Cvc) return;
        try {
            this._control = new Cvc.MixerControl({ name: o.name || 'hush' });
            this._signals.push([this._control, this._control.connect('state-changed', (c, state) => this._onState(state))]);
            this._signals.push([this._control, this._control.connect('stream-added', (c, id) => this._onStreamAdded(id))]);
            this._signals.push([this._control, this._control.connect('stream-removed', (c, id) => this._onStreamRemoved(id))]);
            this._control.open();
        } catch (e) {
            this.available = false;
            this._control = null;
        }
    }

    get streams() { return Array.from(this._streams.values()); }

    onChanged(cb) {
        if (this._destroyed) return 0;
        const id = this._nextId++;
        this._handlers.set(id, cb);
        return id;
    }

    disconnect(id) { this._handlers.delete(id); }

    _onState(state) {
        if (this._destroyed || !Cvc) return;
        if (state === Cvc.MixerControlState.READY) {
            this.ready = true;
            this._rescan();
        } else if (state === Cvc.MixerControlState.FAILED || state === Cvc.MixerControlState.CLOSED) {
            this.ready = false;
            this._streams.clear();
            this._update();
        }
    }

    _rescan() {
        this._streams.clear();
        let outs = [];
        try { outs = this._control.get_source_outputs() || []; } catch (e) { outs = []; }
        for (const s of outs) if (_qualifies(s)) this._streams.set(s.id, { index: s.index, name: String(s.name || ''), icon: String(s['icon-name'] || '') });
        this._update();
    }

    _onStreamAdded(id) {
        if (this._destroyed) return;
        let s = null;
        try { s = this._control.lookup_stream_id(id); } catch (e) { s = null; }
        if (!_qualifies(s)) return;
        this._streams.set(id, { index: s.index, name: String(s.name || ''), icon: String(s['icon-name'] || '') });
        this._update();
    }

    _onStreamRemoved(id) {
        if (this._destroyed) return;
        if (this._streams.delete(id)) this._update();
    }

    _update() {
        const active = this._streams.size > 0;
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
        if (this._control) { try { this._control.close(); } catch (e) { /* already closed */ } }
        this._control = null;
        this._streams.clear();
        this.active = false;
        this.ready = false;
    }
}
