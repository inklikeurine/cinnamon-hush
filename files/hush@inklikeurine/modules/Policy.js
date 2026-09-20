// Policy.js — decides what happens to one notification record. Pure;
// headless-tested against every combination in policy.test.js.
//
//   Policy.decide(record, {
//       dnd: true,               // Hush's own Do Not Disturb is active (manual / schedule / trigger)
//       trayEnabled: true,       // org.cinnamon.desktop.notifications display-notifications
//       allowCritical: true,     // setting: critical notifications still get a banner during DND
//       muted: { 'org.mozilla.thunderbird': { drop: false } }   // setting: muted-apps by app id
//   })
//   → 'banner'   the message tray shows it (sound unless suppress-sound); record state 'unread'
//   → 'silent'   record only, flagged missed — the user sees it in the drawer, nothing is announced
//   → 'drop'     muted with "drop": not shown, not kept
//
// trayEnabled matters because Cinnamon's tray destroys every queued banner
// while that key is false (messageTray.js _updateState); handing it one
// would only lose the sound and the banner, so Hush keeps it silently instead.

const Parse = require('./modules/Parse');

var Decision = Object.freeze({ BANNER: 'banner', SILENT: 'silent', DROP: 'drop' });

function _mutedEntry(muted, appId) {
    if (!muted || !appId) return null;
    if (muted instanceof Map) return muted.get(appId) || null;
    return Object.prototype.hasOwnProperty.call(muted, appId) ? muted[appId] : null;
}

function decide(record, ctx) {
    const c = ctx || {};
    const entry = _mutedEntry(c.muted, record && record.appId);
    if (entry) return entry.drop === true ? Decision.DROP : Decision.SILENT;

    const critical = !!record && record.urgency === Parse.Urgency.CRITICAL;
    if (c.trayEnabled === false) return Decision.SILENT;
    if (c.dnd) return (critical && c.allowCritical !== false) ? Decision.BANNER : Decision.SILENT;
    return Decision.BANNER;
}

// Reads the `muted-apps` settings list ([{app, name, drop}]) into the lookup
// shape decide() expects. Tolerates junk entries.
function mutedFromList(list) {
    const out = {};
    if (!Array.isArray(list)) return out;
    for (const item of list) {
        if (!item || typeof item.app !== 'string' || item.app.trim() === '') continue;
        out[item.app.trim().toLowerCase()] = { drop: item.drop === true, name: typeof item.name === 'string' ? item.name : '' };
    }
    return out;
}
