// TestNotify.js: every preset of the settings "Test" page, sent over the real
// session bus to an Intake exported on a private path (never to the desktop).
imports.searchPath.unshift(ARGV[1]);
const T = imports.lib;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const require = T.makeRequire(ARGV[0]);
const Intake = require('./modules/Intake').Intake;
const TN = require('./modules/TestNotify');
const TestNotify = TN.TestNotify;

const bus = Gio.DBus.session;
const PATH = '/org/inklikeurine/HushTestNotify' + new Gio.Credentials().get_unix_pid();
const stock = { export() {}, unexport() {} };
const intake = new Intake({ stockImpl: stock, path: PATH, idBase: 7000, removeOld: false });
T.eq(intake.install(), true, 'intake on the private path');
const sender = new TestNotify({ bus, name: bus.get_unique_name(), path: PATH });

// Collect every 'notification' event as [record, isUpdate].
const seen = [];
intake.connect('notification', (i, rec, isUpdate) => seen.push([rec, isUpdate]));
const sleep = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { r(); return GLib.SOURCE_REMOVE; }));
async function settle(count, timeoutMs) {
    const until = Date.now() + (timeoutMs || 4000);
    while (seen.length < count && Date.now() < until) await sleep(50);
    return seen.length >= count;
}

T.run('presets are well formed and the schema buttons match them', () => {
    const names = sender.names();
    T.eq(names.length, 12, 'twelve presets');
    for (const n of names) {
        const p = TN.PRESETS[n];
        T.ok(typeof p.summary === 'string' && p.summary.length > 0, n + ': summary');
        T.ok(Array.isArray(p.actions) && p.actions.length % 2 === 0, n + ': actions in pairs');
        T.ok(p.hints && typeof p.hints.urgency === 'number', n + ': urgency hint');
    }
    const schema = T.readJson(ARGV[0] + '/settings-schema.json');
    const src = T.readFile(ARGV[0] + '/applet.js');
    const buttons = Object.keys(schema).filter(k => schema[k].type === 'button');
    T.ok(buttons.length >= 15, 'schema has the test buttons');
    for (const b of buttons) {
        const cb = schema[b].callback;
        T.ok(new RegExp('\\b' + cb + '\\s*\\(').test(src), 'applet.js defines ' + cb + '()');
        if (b.startsWith('test-') && !['test-toggle-dnd', 'test-open-drawer', 'test-clear', 'test-inhibit'].includes(b))
            T.ok(names.includes(cb.replace(/^test_/, '')), b + ' maps to a preset');
    }
    T.eq(TN.tuple({ summary: 's' }, 0).length, 8, 'tuple has 8 members');
    T.eq(TN.tuple({}, -1)[1], 4294967295, 'replaces id is unsigned');
});

T.runAsync('simple presets arrive with their urgency, hints and the x-hush-test marker', async () => {
    const expect = {
        normal: { urgency: 1 }, low: { urgency: 0 }, critical: { urgency: 2, expires: 0 },
        actions: { urgency: 1, nActions: 3 }, markup: { urgency: 1 }, transient: { urgency: 1, transient: true },
        silent: { urgency: 1, suppressSound: true }, image: { urgency: 1, imagePath: 'emblem-photos' },
        app: { urgency: 1, desktopEntry: 'cinnamon-settings' }, long: { urgency: 1 }
    };
    for (const name of Object.keys(expect)) {
        seen.length = 0;
        const id = await sender.send(name);
        T.ok(id >= 7000, name + ': id from the intake');
        T.ok(await settle(1), name + ': record emitted');
        const [rec, isUpdate] = seen[0];
        T.eq(rec.id, id, name + ': same id');
        T.eq(isUpdate, false, name + ': new');
        T.eq(rec.hints['x-hush-test'], true, name + ': marker hint');
        T.eq(rec.summary, TN.PRESETS[name].summary, name + ': summary');
        const e = expect[name];
        T.eq(rec.urgency, e.urgency, name + ': urgency');
        if (e.expires !== undefined) T.eq(rec.expires, e.expires, name + ': expires');
        if (e.nActions !== undefined) T.eq(rec.actions.length, e.nActions, name + ': actions');
        if (e.transient !== undefined) T.eq(rec.transient, e.transient, name + ': transient');
        if (e.suppressSound !== undefined) T.eq(rec.suppressSound, e.suppressSound, name + ': suppress-sound');
        if (e.imagePath !== undefined) T.eq(rec.imagePath, e.imagePath, name + ': image-path');
        if (e.desktopEntry !== undefined) T.eq(rec.desktopEntry, e.desktopEntry, name + ': desktop-entry');
    }
    T.eq(seen[0][0].body.includes('<b>bold</b>'), false, 'last preset is long, not markup');
});

T.runAsync('updating: one id, four in-place updates, resident, final actions cleared', async () => {
    seen.length = 0;
    const id = await sender.send('updating');
    T.ok(await settle(5, 9000), 'five events');
    T.eq(seen.map(([r]) => r.id), [id, id, id, id, id], 'same id throughout');
    T.eq(seen.map(([, u]) => u), [false, true, true, true, true], 'first new, rest updates');
    T.eq(seen[0][0].resident, true, 'resident');
    T.eq(seen[0][0].actions.length, 1, 'cancel button at first');
    T.eq(seen[4][0].summary, 'Download finished', 'final summary');
    T.eq(seen[4][0].actions, [], 'final step has no actions');
    T.eq(seen[4][0].updates, 4, 'update counter');
}, 15);

T.runAsync('burst: five records from three apps, in order', async () => {
    seen.length = 0;
    await sender.send('burst');
    T.ok(await settle(5, 6000), 'five events');
    T.eq(seen.map(([r]) => r.appName), ['Mail', 'Messenger', 'Mail', 'Software Updater', 'Messenger'], 'apps in order');
    T.eq(new Set(seen.map(([r]) => r.id)).size, 5, 'distinct ids');
    T.eq(seen.every(([, u]) => u === false), true, 'all new');
    T.eq(seen[2][0].urgency, 0, 'digest is low urgency');
});

T.runAsync('unknown preset rejects; destroy cancels a pending update sequence', async () => {
    let threw = false;
    try { await sender.send('nope'); } catch (e) { threw = true; }
    T.eq(threw, true, 'unknown name');
    seen.length = 0;
    const s2 = new TestNotify({ bus, name: bus.get_unique_name(), path: PATH });
    const p = s2.send('updating');
    await settle(1);
    s2.destroy();
    await sleep(1500);
    T.eq(seen.length, 1, 'no update after destroy');
    let rejected = false;
    try { await s2.notify({ summary: 'x' }, 0); } catch (e) { rejected = true; }
    T.eq(rejected, true, 'notify after destroy rejects');
    void p;
});

sender.destroy();
intake.destroy();
T.exit();
