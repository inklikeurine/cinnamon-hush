// ListDiff.js — bookkeeping for the drawer's incremental list. Pure: no
// Clutter, no St. The drawer keeps one actor per group and per record and
// asks this module what changed between two renders, so only the actors
// that entered or left are touched and the rest keep their position,
// scroll offset and hover state.
//
//   groupKey(group, cleared)   'g:<appId>' | 'c:<appId>'
//   rowKey(record, cleared)    'r:<id>'    | 'x:<id>'
//   signature(record)          string; equal ⇔ the row's content needs no re-render
//                              (unread state is not part of it — that is a class toggle)
//   plan(current, desired)     current: [{ key, leaving }] in the container's present
//                              order, where `leaving` marks an actor already animating
//                              out (its key never equals a desired key); desired: [key]
//                              → { enter: [key], leave: [key], order: [key] }
//                              enter: desired keys with no live actor, in desired order
//                              leave: live keys no longer desired, in present order
//                              order: the full child order to apply — desired keys in
//                              order, every leaving actor (old or new) kept right after
//                              the live neighbour it followed so it collapses in place
//   stagger(n, step, cap)      [0, step, 2·step, …] capped at cap — delays for n
//                              departures so a Clear all cascades instead of vanishing

function groupKey(group, cleared) {
    const id = group && group.appId ? String(group.appId) : 'unknown';
    return (cleared ? 'c:' : 'g:') + id;
}

function rowKey(record, cleared) {
    const id = record && record.id !== undefined ? String(record.id) : '?';
    return (cleared ? 'x:' : 'r:') + id;
}

function signature(record) {
    const r = record || {};
    const actions = Array.isArray(r.actions)
        ? r.actions.filter(a => a && a.key !== 'default').map(a => a.key + '=' + (a.label || '')).join(',')
        : '';
    return [
        r.summary || '',
        r.body || '',
        String(r.time | 0),
        String(r.urgency | 0),
        (r.closed || r.senderGone) ? 'dead' : 'live',
        actions
    ].join('\u001f');
}

function plan(current, desired) {
    const cur = Array.isArray(current) ? current : [];
    const want = Array.isArray(desired) ? desired : [];
    const wanted = new Set(want);
    const live = new Set();
    for (const c of cur) if (c && !c.leaving) live.add(c.key);

    const enter = want.filter(k => !live.has(k));
    const leave = cur.filter(c => c && !c.leaving && !wanted.has(c.key)).map(c => c.key);

    // Every actor that is or becomes leaving is anchored to the closest
    // preceding actor that stays; null anchors go to the top.
    const trailing = new Map();
    let anchor = null;
    for (const c of cur) {
        if (!c) continue;
        if (!c.leaving && wanted.has(c.key)) { anchor = c.key; continue; }
        if (!trailing.has(anchor)) trailing.set(anchor, []);
        trailing.get(anchor).push(c.key);
    }
    const order = [];
    if (trailing.has(null)) order.push(...trailing.get(null));
    for (const k of want) {
        order.push(k);
        if (trailing.has(k)) order.push(...trailing.get(k));
    }
    return { enter, leave, order };
}

function stagger(n, step, cap) {
    const count = Math.max(0, n | 0);
    const s = typeof step === 'number' && step >= 0 ? step : 35;
    const c = typeof cap === 'number' && cap >= 0 ? cap : 280;
    const out = [];
    for (let i = 0; i < count; i++) out.push(Math.min(i * s, c));
    return out;
}
