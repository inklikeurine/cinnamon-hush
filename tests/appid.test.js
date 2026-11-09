// AppId.js: stable id + label from the desktop-entry hint / resolved app / app_name.
imports.searchPath.unshift(ARGV[1]);
const T = imports.lib;
const require = T.makeRequire(ARGV[0]);
const AppId = require('./modules/AppId');

T.run('desktop-entry wins, lower-cased, .desktop stripped', () => {
    T.eq(AppId.derive({ desktopEntry: 'org.mozilla.Thunderbird.desktop', appName: 'Thunderbird' }),
        { id: 'org.mozilla.thunderbird', label: 'Thunderbird' }, 'entry');
});

T.run('resolved desktop id used when there is no hint; resolved name preferred for the label', () => {
    T.eq(AppId.derive({ resolvedDesktopId: 'Signal.desktop', resolvedName: 'Signal Messenger', appName: 'signal' }),
        { id: 'signal', label: 'Signal Messenger' }, 'resolved');
});

T.run('falls back to a slug of app_name', () => {
    T.eq(AppId.derive({ appName: 'Software Updater' }), { id: 'software-updater', label: 'Software Updater' }, 'slug');
    T.eq(AppId.derive({ appName: '  notify-send ' }), { id: 'notify-send', label: 'notify-send' }, 'trimmed');
});

T.run('nothing at all → unknown', () => {
    T.eq(AppId.derive({}), { id: 'unknown', label: 'unknown' }, 'empty');
    T.eq(AppId.derive(null), { id: 'unknown', label: 'unknown' }, 'null');
});

T.run('label falls back to the desktop entry when app_name is empty', () => {
    T.eq(AppId.derive({ desktopEntry: 'com.example.Thing', appName: '' }), { id: 'com.example.thing', label: 'com.example.Thing' }, 'entry label');
});

T.run('normaliseDesktopId', () => {
    T.eq(AppId.normaliseDesktopId('Firefox.desktop'), 'firefox', 'strip');
    T.eq(AppId.normaliseDesktopId('weird name!!'), 'weird-name', 'slug');
});

T.exit();
