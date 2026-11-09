// Intake.js over the real session bus: exported on a private path with a fake
// stock handler, driven by calls to our own unique name. Nothing touches
// /org/freedesktop/Notifications.
imports.searchPath.unshift(ARGV[1]);
const T = imports.lib;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const require = T.makeRequire(ARGV[0]);
const Intake = require('./modules/Intake').Intake;
const Parse = require('./modules/Parse');

const IFACE = 'org.freedesktop.Notifications';
const MY_PID = new Gio.Credentials().get_unix_pid();
const PATH = '/org/inklikeurine/HushTest' + MY_PID;
const bus = Gio.DBus.session;
const me = bus.get_unique_name();

function fakeStock() {
    return { exported: true, export() { this.exported = true; }, unexport() { this.exported = false; } };
}

function call(method, variant, conn) {
    return new Promise((resolve, reject) => {
        (conn || bus).call(me, PATH, IFACE, method, variant || null, null, Gio.DBusCallFlags.NONE, 5000, null, (c, res) => {
            try { resolve(c.call_finish(res).deep_unpack()); } catch (e) { reject(e); }
        });
    });
}

function notify(args, conn) {
    const [app, replaces, icon, summary, body, actions, hints, timeout] = args;
    const h = {};
    for (const k of Object.keys(hints || {})) h[k] = hints[k];
    return call('Notify', new GLib.Variant('(susssasa{sv}i)', [app, replaces, icon, summary, body, actions, h, timeout]), conn);
}

function once(obj, signal, timeoutMs) {
    return new Promise((resolve, reject) => {
        let timer = 0;
        const id = obj.connect(signal, (...args) => {
            obj.disconnect(id);
            if (timer) GLib.source_remove(timer);
            resolve(args.slice(1));
        });
        timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs || 4000, () => { obj.disconnect(id); reject(new Error('no ' + signal)); return GLib.SOURCE_REMOVE; });
    });
}

function busSignal(name, timeoutMs) {
    return new Promise((resolve, reject) => {
        let timer = 0;
        const sub = bus.signal_subscribe(null, IFACE, name, PATH, null, Gio.DBusSignalFlags.NONE, (c, sender, path, iface, sig, params) => {
            bus.signal_unsubscribe(sub);
            if (timer) GLib.source_remove(timer);
            resolve(params.deep_unpack());
        });
        timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs || 4000, () => { bus.signal_unsubscribe(sub); reject(new Error('no bus signal ' + name)); return GLib.SOURCE_REMOVE; });
    });
}

const sleep = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { r(); return GLib.SOURCE_REMOVE; }));

T.run('install needs a stock handler; failure changes nothing', () => {
    const i = new Intake({ stockImpl: null, path: PATH });
    T.eq(i.install(), false, 'no stock');
    T.ok(/not found/.test(i.error), 'error set');
    T.eq(i.installed, false, 'not installed');
    const broken = { export() {}, unexport() { throw new Error('nope'); } };
    const j = new Intake({ stockImpl: broken, path: PATH });
    T.eq(j.install(), false, 'unexport threw');
    T.ok(/unexport/.test(j.error), 'error names the step');
    j.destroy(); i.destroy();
});

T.run('install swaps, is idempotent, uninstall restores; a second export on the path fails cleanly', () => {
    const stock = fakeStock();
    const i = new Intake({ stockImpl: stock, path: PATH });
    T.eq(i.install(), true, 'installed');
    T.eq(stock.exported, false, 'stock unexported');
    T.eq(i.install(), true, 'idempotent');
    const other = new Intake({ stockImpl: fakeStock(), path: PATH });
    T.eq(other.install(), false, 'path occupied');
    T.ok(/could not export/.test(other.error), 'export error');
    T.eq(other._stock.exported, true, 'other restored its stock after the failed export');
    i.uninstall();
    T.eq(i.installed, false, 'uninstalled');
    T.eq(stock.exported, true, 'stock re-exported');
    i.uninstall();
    other.destroy(); i.destroy();
});

const stock = fakeStock();
const intake = new Intake({ stockImpl: stock, path: PATH, serverInfo: ['Hush', 'inklikeurine', '0.1.0', '1.2'], idBase: 5000, defaultTimeoutSec: 1800, removeOld: true });
T.eq(intake.install(), true, 'installed for the bus tests');

T.runAsync('GetServerInformation / GetCapabilities answer over the bus', async () => {
    T.eq(await call('GetServerInformation'), ['Hush', 'inklikeurine', '0.1.0', '1.2'], 'server info');
    const [caps] = await call('GetCapabilities');
    T.eq(caps, ['actions', 'action-icons', 'body', 'body-markup', 'icon-static', 'persistence', 'sound'], 'capabilities');
});

T.runAsync('Notify returns an id from the base and emits a record with sender + pid', async () => {
    const got = once(intake, 'notification');
    const [id] = await notify(['App', 0, 'icon', 'Hello', 'world', ['default', 'Open'], { urgency: GLib.Variant.new_byte(1), 'desktop-entry': GLib.Variant.new_string('org.example.App') }, -1]);
    T.eq(id, 5000, 'first id');
    const [record, isUpdate] = await got;
    T.eq(record.id, 5000, 'record id');
    T.eq(isUpdate, false, 'new');
    T.eq(record.sender, me, 'sender is our unique name');
    T.eq(record.pid, MY_PID, 'pid resolved through org.freedesktop.DBus');
    T.eq(record.summary, 'Hello', 'summary');
    T.eq(record.desktopEntry, 'org.example.App', 'hint');
    T.eq(record.actions, [{ key: 'default', label: 'Open' }], 'actions');
    T.eq(intake.count, 1, 'one open record');
    T.ok(record.expires > Date.now(), 'expires armed from default');
});

T.runAsync('replaces_id updates in place; unknown replaces_id is a new record', async () => {
    const got = once(intake, 'notification');
    const [id] = await notify(['App', 5000, '', 'Hello again', '', [], {}, -1]);
    T.eq(id, 5000, 'same id');
    const [record, isUpdate] = await got;
    T.eq(isUpdate, true, 'update');
    T.eq(record.updates, 1, 'updates');
    T.eq(record.pid, MY_PID, 'pid carried over');
    T.eq(intake.count, 1, 'still one');
    const got2 = once(intake, 'notification');
    const [id2] = await notify(['App', 424242, '', 'Other', '', [], {}, -1]);
    T.eq(id2, 5001, 'fresh id');
    await got2;
    T.eq(intake.count, 2, 'two');
});

T.runAsync('CloseNotification from the client → NotificationClosed(APP_CLOSED) on the bus and a closed event', async () => {
    const sig = busSignal('NotificationClosed');
    const ev = once(intake, 'closed');
    await call('CloseNotification', new GLib.Variant('(u)', [5001]));
    T.eq(await sig, [5001, Parse.ClosedReason.APP_CLOSED], 'bus signal');
    const [record, reason] = await ev;
    T.eq(record.id, 5001, 'record');
    T.eq(reason, 3, 'reason');
    T.eq(record.closed, true, 'closed flag');
    T.eq(intake.count, 1, 'removed from open set');
});

T.runAsync('close() from the applet side, invokeAction, and unknown ids', async () => {
    const act = busSignal('ActionInvoked');
    T.eq(intake.invokeAction(5000, 'default'), true, 'action sent');
    T.eq(await act, [5000, 'default'], 'ActionInvoked');
    T.eq(intake.invokeAction(9999, 'x'), false, 'unknown id');
    const sig = busSignal('NotificationClosed');
    T.eq(intake.close(5000, Parse.ClosedReason.DISMISSED), true, 'closed');
    T.eq(await sig, [5000, 2], 'DISMISSED');
    T.eq(intake.close(5000, 2), false, 'already closed');
    T.eq(intake.count, 0, 'none open');
});

T.runAsync('expiry: a custom timeout closes with EXPIRED; removeOld=false never expires', async () => {
    const closed = once(intake, 'closed', 4000);
    const got = once(intake, 'notification');
    await notify(['App', 0, '', 'Short', '', [], {}, 1100]);
    await got;
    const [record, reason] = await closed;
    T.eq(record.summary, 'Short', 'the short one');
    T.eq(reason, Parse.ClosedReason.EXPIRED, 'EXPIRED');
    intake.setExpiry({ removeOld: false });
    const got2 = once(intake, 'notification');
    const [id] = await notify(['App', 0, '', 'Kept', '', [], {}, 1000]);
    await got2;
    await sleep(1600);
    T.eq(intake.get(id) !== null, true, 'still open with removeOld=false');
    intake.setExpiry({ removeOld: true });
    await once(intake, 'closed', 3000);
    T.eq(intake.get(id), null, 'expired once removeOld is back on');
});

T.runAsync('closeAll closes every open record with APP_CLOSED', async () => {
    const a = once(intake, 'notification'); await notify(['A', 0, '', '1', '', [], {}, 0]); await a;
    const b = once(intake, 'notification'); await notify(['B', 0, '', '2', '', [], {}, 0]); await b;
    T.eq(intake.count, 2, 'two open');
    T.eq(intake.closeAll(), 2, 'closed two');
    T.eq(intake.count, 0, 'none');
});

T.runAsync('a sender that leaves the bus marks its records senderGone and emits sender-gone', async () => {
    const address = Gio.dbus_address_get_for_bus_sync(Gio.BusType.SESSION, null);
    const conn = await new Promise((resolve, reject) => {
        Gio.DBusConnection.new_for_address(address,
            Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
            null, null, (o, res) => { try { resolve(Gio.DBusConnection.new_for_address_finish(res)); } catch (e) { reject(e); } });
    });
    const got = once(intake, 'notification');
    const [id] = await notify(['Guest', 0, '', 'From a second connection', '', [], {}, 0], conn);
    const [record] = await got;
    T.eq(record.sender, conn.get_unique_name(), 'sender is the second connection');
    T.eq(record.senderGone, false, 'alive');
    const gone = once(intake, 'sender-gone', 5000);
    await new Promise(r => conn.close(null, () => r()));
    const [sender] = await gone;
    T.eq(sender, record.sender, 'sender-gone names it');
    T.eq(intake.get(id).senderGone, true, 'record flagged');
    T.eq(intake._senderWatch.has(sender), false, 'watch released');
});

T.runAsync('uninstall: our object stops answering, stock is back; destroy is safe twice', async () => {
    intake.uninstall();
    T.eq(stock.exported, true, 'stock restored');
    let failed = false;
    try { await call('GetServerInformation'); } catch (e) { failed = true; }
    T.eq(failed, true, 'no longer exported');
    intake.destroy();
    intake.destroy();
    T.eq(intake.count, 0, 'cleared');
});

T.exit();
