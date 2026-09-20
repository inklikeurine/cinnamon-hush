// AppId.js — a stable identifier and a display name for the application
// behind a notification. Pure; the shell-side lookups (desktop file from a
// pid, Cinnamon.App) happen in applet.js and are passed in as strings.
//
//   AppId.derive({ desktopEntry: 'org.mozilla.Thunderbird', appName: 'Thunderbird' })
//     → { id: 'org.mozilla.thunderbird', label: 'Thunderbird' }
//
// Precedence for the id: the `desktop-entry` hint, then the desktop file
// Cinnamon resolved from the sender's pid, then a slug of app_name. The
// label prefers the resolved app's name, then app_name, then the id.
// Everything is lower-cased and stripped of `.desktop` so that the same app
// hashes to the same id whichever path identified it.

function _slug(text) {
    return String(text || '')
        .trim()
        .toLowerCase()
        .replace(/\.desktop$/, '')
        .replace(/[^a-z0-9._+-]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function normaliseDesktopId(desktopId) {
    return _slug(desktopId);
}

// info: { desktopEntry, resolvedDesktopId, resolvedName, appName }
function derive(info) {
    const i = info || {};
    let id = _slug(i.desktopEntry);
    if (!id) id = _slug(i.resolvedDesktopId);
    if (!id) id = _slug(i.appName);
    if (!id) id = 'unknown';

    let label = String(i.resolvedName || '').trim();
    if (!label) label = String(i.appName || '').trim();
    if (!label) label = String(i.desktopEntry || '').trim().replace(/\.desktop$/, '');
    if (!label) label = id;

    return { id, label };
}
