// Recording.js against the real sound server (read-only): the mixer reaches
// READY, the qualifying-stream filter behaves, destroy releases the control.
imports.searchPath.unshift(ARGV[1]);
const T = imports.lib;
const GLib = imports.gi.GLib;
const require = T.makeRequire(ARGV[0]);
const Recording = require('./modules/Recording').Recording;

let Cvc = null;
try { Cvc = imports.gi.Cvc; } catch (e) { Cvc = null; }

if (!Cvc) {
    T.skip('Cvc typelib', 'imports.gi.Cvc unavailable');
} else {
    T.runAsync('opens a MixerControl, reaches READY, reports a boolean and a stream list', async () => {
        const rec = new Recording({ name: 'hush-test' });
        T.eq(rec.available, true, 'available');
        const until = Date.now() + 5000;
        while (!rec.ready && Date.now() < until) await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => { r(); return false; }));
        if (!rec.ready) { T.skip('sound server', 'MixerControl did not reach READY in 5 s'); rec.destroy(); return; }
        T.eq(typeof rec.active, 'boolean', 'active is boolean');
        T.ok(Array.isArray(rec.streams), 'streams');
        T.eq(rec.active, rec.streams.length > 0, 'active iff a qualifying stream exists');
        for (const s of rec.streams) T.ok(typeof s.index === 'number' && typeof s.name === 'string', 'stream shape');
        const id = rec.onChanged(() => {});
        T.ok(id > 0, 'handler id');
        rec.disconnect(id);
        rec.destroy();
        T.eq(rec.active, false, 'inactive after destroy');
        T.eq(rec.ready, false, 'not ready after destroy');
        T.eq(rec.onChanged(() => {}), 0, 'no handlers after destroy');
        rec.destroy();
    }, 10);
}

T.exit();
