// Parse.js: Notify argument tuple → record, against sanitised fixtures.
imports.searchPath.unshift(ARGV[1]);
const T = imports.lib;
const GLib = imports.gi.GLib;
const require = T.makeRequire(ARGV[0]);
const Parse = require('./modules/Parse');

const F = T.fixtureJson('notify-tuples.json');
const NOW = 1_700_000_000_000;
const opts = (extra) => Object.assign({ id: 7, now: NOW, sender: ':1.42', defaultTimeoutSec: 1800 }, extra || {});

T.run('plain notify-send: defaults, expiry from the gsettings default', () => {
    const r = Parse.parse(F['notify-send'], opts());
    T.eq(r.id, 7, 'id from opts');
    T.eq(r.appName, 'notify-send', 'appName');
    T.eq(r.summary, 'Build finished', 'summary');
    T.eq(r.body, '3 warnings', 'body');
    T.eq(r.urgency, 1, 'urgency');
    T.eq(r.actions, [], 'no actions');
    T.eq(r.expires, NOW + 1800 * 1000, 'expires = now + timeout default');
    T.eq(r.time, NOW, 'time');
    T.eq(r.sender, ':1.42', 'sender');
    T.eq(r.state, 'unread', 'initial state');
    T.eq(r.transient, false, 'transient default');
    T.eq(r.resident, false, 'resident default');
    T.eq(r.suppressSound, false, 'suppress-sound default');
    T.eq(r.appIcon, '', 'no icon');
    T.eq(r.hasImageData, false, 'no image data');
});

T.run('mail client: desktop-entry, category, actions in pairs, absolute image-path → file URI', () => {
    const r = Parse.parse(F['mail-client'], opts());
    T.eq(r.desktopEntry, 'org.example.Mail', 'desktop-entry');
    T.eq(r.category, 'email.arrived', 'category');
    T.eq(r.actions, [{ key: 'default', label: 'Open' }, { key: 'mark-read', label: 'Mark read' }], 'actions');
    T.eq(r.imagePath, 'file:///usr/share/icons/hicolor/48x48/apps/mail.png', 'image-path as URI');
    T.eq(r.appIcon, 'mail-unread', 'icon name kept');
});

T.run('legacy icon_data becomes image-data; transient + suppress-sound; custom timeout', () => {
    const r = Parse.parse(F['player-legacy-icon-data'], opts());
    T.eq(r.hasImageData, true, 'image-data present');
    T.eq(r.hints['image-data'][0], 2, 'width');
    T.eq(r.hints['icon_data'], undefined, 'alias removed');
    T.eq(r.transient, true, 'transient');
    T.eq(r.suppressSound, true, 'suppress-sound');
    T.eq(r.urgency, 0, 'low urgency');
    T.eq(r.expires, NOW + 5000, 'custom timeout in ms');
    Parse.stripHeavy(r);
    T.eq(r.hints['image-data'], undefined, 'stripHeavy drops the pixels');
    T.eq(r.hasImageData, true, 'but remembers there were some');
});

T.run('image_path alias (spec 1.1) → image-path URI', () => {
    const r = Parse.parse(F['player-image-path-alias'], opts());
    T.eq(r.imagePath, 'file:///tmp/cover.png', 'aliased and converted');
    T.eq(r.hints['image_path'], undefined, 'alias removed');
});

T.run('critical never expires, resident never expires, timeout 0 never expires', () => {
    T.eq(Parse.parse(F['critical'], opts()).expires, 0, 'critical + timeout 0');
    T.eq(Parse.parse(F['resident-timeout'], opts()).expires, 0, 'resident with -1');
    const crit = Parse.parse(['x', 0, '', 's', '', [], { urgency: 2 }, -1], opts());
    T.eq(crit.expires, 0, 'critical with -1');
    T.eq(crit.urgency, 2, 'urgency 2');
    T.eq(Parse.parse(F['custom-timeout'], opts()).expires, NOW + 2500, 'custom 2500 ms');
});

T.run('XChat summary rewrite (parity with the stock daemon)', () => {
    const r = Parse.parse(F['xchat'], opts());
    T.eq(r.summary, '<carol>', 'rewritten');
});

T.run('action-icons hint', () => {
    const r = Parse.parse(F['action-icons'], opts());
    T.eq(r.actionIcons, true, 'action-icons');
    T.eq(r.actions, [{ key: 'media-playback-pause-symbolic', label: 'Pause' }], 'actions');
});

T.run('odd types never throw and fall back to defaults', () => {
    const r = Parse.parse(F['odd-types'], opts());
    T.eq(r.actions, [], 'non-array actions');
    T.eq(r.urgency, 1, 'string urgency → normal');
    T.eq(r.transient, false, 'string transient → false');
    T.eq(r.timeout, -1, 'string timeout → default');
    T.eq(r.summary, '', 'empty summary');
    const r2 = Parse.parse([null, undefined, null, null, null, null, null, null], opts());
    T.eq(r2.appName, '', 'null appName');
    T.eq(r2.replacesId, 0, 'null replaces');
});

T.run('replaces_id is kept when > 0', () => {
    const r = Parse.parse(['x', 99, '', 's', '', [], {}, -1], opts());
    T.eq(r.replacesId, 99, 'replacesId');
});

T.run('hints given as GLib.Variant values are unpacked', () => {
    const hints = { urgency: GLib.Variant.new_byte(2), 'desktop-entry': GLib.Variant.new_string('org.example.App'), 'transient': GLib.Variant.new_boolean(true) };
    const r = Parse.parse(['App', 0, '', 's', 'b', [], hints, -1], opts());
    T.eq(r.urgency, 2, 'byte urgency');
    T.eq(r.desktopEntry, 'org.example.App', 'string hint');
    T.eq(r.transient, true, 'boolean hint');
});

T.run('absolute app_icon path → file URI; relative/name untouched', () => {
    T.eq(Parse.parse(['a', 0, '/usr/share/pixmaps/x.png', 's', '', [], {}, -1], opts()).appIcon, 'file:///usr/share/pixmaps/x.png', 'absolute');
    T.eq(Parse.parse(['a', 0, 'dialog-information', 's', '', [], {}, -1], opts()).appIcon, 'dialog-information', 'name');
    T.eq(Parse.parse(['a', 0, 'file:///x.png', 's', '', [], {}, -1], opts()).appIcon, 'file:///x.png', 'uri');
});

T.exit();
