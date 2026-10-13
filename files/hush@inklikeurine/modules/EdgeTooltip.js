// EdgeTooltip.js — Cinnamon's Tooltips.Tooltip, kept on the monitor.
//
//   const tip = EdgeTooltip.create(actor, text);   // a Tooltips.Tooltip
//
// Cinnamon 6.6's Tooltip.show() clamps the tooltip to the monitor with the
// width of the label's previous allocation, which is 0 before its first
// show (and stale after a text change), and never clamps vertically. The
// drawer sits against the screen edge, so its tooltips ran off the screen.
// create() lets Cinnamon show the tooltip, then moves it by its preferred
// size (js/ui/tooltips.js, Tooltip.show()).

var GAP = 4;   // px between the pointer and a tooltip flipped above it

// Where a w × h tooltip that Cinnamon put at (x, y) goes to stay on
// `monitor` ({ x, y, width, height }): pulled left from the right edge,
// flipped above the pointer at `mouseY` when it would cross the bottom.
function place(x, y, w, h, monitor, mouseY) {
    const right = monitor.x + monitor.width;
    const bottom = monitor.y + monitor.height;
    x = Math.max(monitor.x, Math.min(x, right - w));
    if (y + h > bottom) y = mouseY - h - GAP;
    y = Math.max(monitor.y, Math.min(y, bottom - h));
    return [x, y];
}

function create(actor, text) {
    const Tooltips = imports.ui.tooltips;
    const Main = imports.ui.main;
    const tip = new Tooltips.Tooltip(actor, text);
    const show = tip.show;
    tip.show = function () {
        show.call(this);
        if (!this.visible || !this.mousePosition) return;
        const monitor = Main.layoutManager.findMonitorForActor(this.item);
        if (!monitor) return;
        const label = this._tooltip;
        const [, w] = label.get_preferred_width(-1);
        const [, h] = label.get_preferred_height(w);
        const [x, y] = label.get_position();
        const [nx, ny] = place(x, y, w, h, monitor, this.mousePosition[1]);
        if (nx !== x || ny !== y) label.set_position(nx, ny);
    };
    return tip;
}
