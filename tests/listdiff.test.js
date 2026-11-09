// ListDiff.js: the drawer's incremental-list bookkeeping (keys, signatures,
// enter/leave/order plans, stagger delays). Pure module, no shell.
imports.searchPath.unshift(ARGV[1]);
const T = imports.lib;
const require = T.makeRequire(ARGV[0]);
const ListDiff = require('./modules/ListDiff');

const live = keys => keys.map(k => ({ key: k, leaving: false }));

T.run('keys: groups and rows are namespaced by section', () => {
    T.eq(ListDiff.groupKey({ appId: 'org.mozilla.firefox' }, false), 'g:org.mozilla.firefox', 'group');
    T.eq(ListDiff.groupKey({ appId: 'org.mozilla.firefox' }, true), 'c:org.mozilla.firefox', 'cleared group');
    T.eq(ListDiff.groupKey({}, false), 'g:unknown', 'no app id');
    T.eq(ListDiff.rowKey({ id: 12 }, false), 'r:12', 'row');
    T.eq(ListDiff.rowKey({ id: 12 }, true), 'x:12', 'cleared row');
    T.ok(ListDiff.rowKey({ id: 12 }, false) !== ListDiff.rowKey({ id: 12 }, true), 'same record, different sections, different keys');
});

T.run('signature: content only, unread state excluded', () => {
    const base = { id: 1, summary: 'Hi', body: 'there', time: 1000, urgency: 1, state: 'unread', actions: [{ key: 'default', label: 'Open' }, { key: 'reply', label: 'Reply' }] };
    const same = Object.assign({}, base, { state: 'read' });
    T.eq(ListDiff.signature(base), ListDiff.signature(same), 'read/unread does not re-render');
    T.ok(ListDiff.signature(base) !== ListDiff.signature(Object.assign({}, base, { body: 'changed' })), 'body change');
    T.ok(ListDiff.signature(base) !== ListDiff.signature(Object.assign({}, base, { closed: true })), 'closed greys the actions');
    T.ok(ListDiff.signature(base) !== ListDiff.signature(Object.assign({}, base, { senderGone: true })), 'sender gone greys the actions');
    T.ok(ListDiff.signature(base) !== ListDiff.signature(Object.assign({}, base, { urgency: 2 })), 'urgency');
    T.ok(ListDiff.signature(base) !== ListDiff.signature(Object.assign({}, base, { actions: [{ key: 'default', label: 'Open' }] })), 'actions');
    T.eq(ListDiff.signature(base), ListDiff.signature(Object.assign({}, base, { actions: [{ key: 'reply', label: 'Reply' }] })), 'the default action is not rendered');
    T.eq(typeof ListDiff.signature(null), 'string', 'null record');
});

T.run('plan: unchanged list has no work', () => {
    const p = ListDiff.plan(live(['a', 'b', 'c']), ['a', 'b', 'c']);
    T.eq(p.enter, [], 'enter');
    T.eq(p.leave, [], 'leave');
    T.eq(p.order, ['a', 'b', 'c'], 'order');
});

T.run('plan: enters and leaves', () => {
    const p = ListDiff.plan(live(['a', 'b', 'c']), ['n', 'a', 'c']);
    T.eq(p.enter, ['n'], 'new key enters');
    T.eq(p.leave, ['b'], 'dropped key leaves');
    T.eq(p.order, ['n', 'a', 'b', 'c'], 'b collapses in place, after a');
});

T.run('plan: a leaving actor at the top is kept at the top', () => {
    const p = ListDiff.plan(live(['a', 'b']), ['b']);
    T.eq(p.leave, ['a'], 'a leaves');
    T.eq(p.order, ['a', 'b'], 'a stays above b while it animates out');
});

T.run('plan: already-leaving actors follow their live neighbour', () => {
    const current = [{ key: 'a', leaving: false }, { key: 'leaving:1', leaving: true }, { key: 'b', leaving: false }];
    const p = ListDiff.plan(current, ['b', 'a']);
    T.eq(p.enter, [], 'nothing enters');
    T.eq(p.leave, [], 'nothing new leaves');
    T.eq(p.order, ['b', 'a', 'leaving:1'], 'the old leaver moves with a');
});

T.run('plan: a key re-added while its old actor is still leaving enters again', () => {
    const current = [{ key: 'leaving:7', leaving: true }];
    const p = ListDiff.plan(current, ['r:7']);
    T.eq(p.enter, ['r:7'], 'fresh actor');
    T.eq(p.order, ['leaving:7', 'r:7'], 'old one stays where it was');
});

T.run('plan: clear all leaves everything in present order', () => {
    const p = ListDiff.plan(live(['a', 'b', 'c']), []);
    T.eq(p.leave, ['a', 'b', 'c'], 'top-down');
    T.eq(p.order, ['a', 'b', 'c'], 'order preserved for the cascade');
});

T.run('plan: reorder without churn', () => {
    const p = ListDiff.plan(live(['a', 'b', 'c']), ['c', 'a', 'b']);
    T.eq(p.enter, [], 'no enter');
    T.eq(p.leave, [], 'no leave');
    T.eq(p.order, ['c', 'a', 'b'], 'moved');
});

T.run('plan: tolerates bad input', () => {
    T.eq(ListDiff.plan(null, null), { enter: [], leave: [], order: [] }, 'nulls');
    T.eq(ListDiff.plan([null, { key: 'a', leaving: false }], ['a']).order, ['a'], 'null entry skipped');
});

T.run('stagger: capped ramp', () => {
    T.eq(ListDiff.stagger(0), [], 'none');
    T.eq(ListDiff.stagger(1), [0], 'a single dismiss is immediate');
    T.eq(ListDiff.stagger(4, 35, 280), [0, 35, 70, 105], 'ramp');
    T.eq(ListDiff.stagger(12, 35, 280), [0, 35, 70, 105, 140, 175, 210, 245, 280, 280, 280, 280], 'capped');
    T.eq(ListDiff.stagger(3, 0, 0), [0, 0, 0], 'zero step');
    T.eq(ListDiff.stagger(-2), [], 'negative count');
});

T.exit();
