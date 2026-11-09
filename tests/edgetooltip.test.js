// hush@inklikeurine: EdgeTooltip.place() keeps a tooltip on its monitor
// (0.5.1). Cinnamon's Tooltip.show() clamps with a 0 px width before the
// first show and never clamps vertically; the live spec checks the real
// tooltip in the drawer.
imports.searchPath.unshift(ARGV[1]);
const T = imports.lib;
const EdgeTooltip = T.makeRequire(ARGV[0])('./modules/EdgeTooltip');

const MON = { x: 1920, y: 0, width: 2560, height: 1440 };   // a second monitor, right of the first
const RIGHT = MON.x + MON.width, BOTTOM = MON.y + MON.height;

T.run('inside the monitor: unchanged', () => {
    T.eq(EdgeTooltip.place(2500, 600, 237, 40, MON, 580), [2500, 600], 'same position');
});

T.run('past the right edge (Cinnamon clamped with 0 px): pulled back', () => {
    // Cinnamon put it at pointer + 12 with the pointer 20 px from the edge.
    T.eq(EdgeTooltip.place(RIGHT - 8, 600, 237, 40, MON, 580), [RIGHT - 237, 600], 'right edge flush');
});

T.run('past the bottom: flipped above the pointer', () => {
    const mouseY = BOTTOM - 10;
    const [x, y] = EdgeTooltip.place(2000, mouseY + 21, 237, 40, MON, mouseY);
    T.eq(x, 2000, 'x unchanged');
    T.eq(y, mouseY - 40 - EdgeTooltip.GAP, 'above the pointer');
});

T.run('bottom-right corner: both', () => {
    const [x, y] = EdgeTooltip.place(RIGHT - 2, BOTTOM + 19, 237, 40, MON, BOTTOM - 2);
    T.ok(x + 237 <= RIGHT && y + 40 <= BOTTOM && x >= MON.x && y >= MON.y, 'fully on the monitor');
});

T.run('wider than the monitor: left edge wins', () => {
    T.eq(EdgeTooltip.place(2000, 100, 3000, 40, MON, 80)[0], MON.x, 'starts at the monitor edge');
});

T.run('module parses without the shell and ends with a newline', () => {
    const src = T.readFile(ARGV[0] + '/modules/EdgeTooltip.js');
    T.ok(src.endsWith('\n'), 'trailing newline');
    T.eq(typeof EdgeTooltip.create, 'function', 'create exported');
});

T.exit();
