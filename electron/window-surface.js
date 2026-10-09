// V17.0 维护注释：角部透明用于圆角抗锯齿，窗口内部仍由不透明样式绘制。
// 不要用二值区域裁剪代替 alpha，也不要重新加入 client 坐标驱动的位置反馈。
// 这里的边界测试不能证明 Windows 10 的原生拖动、DPI 或四角验收通过。
// Windows candidate: no WS_THICKFRAME and no binary SetWindowRgn mask.
// Chromium paints the antialiased corner alpha; the interior stays opaque.
// Native Windows 10 visual acceptance is still required before release.
const EDGES = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);
function fitBoundsToWorkArea(bounds, area) {
  const width = Math.max(1, Math.min(bounds.width, area.width));
  const height = Math.max(1, Math.min(bounds.height, area.height));
  const x = Number.isFinite(bounds.x) ? Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)) : Math.round(area.x + (area.width - width) / 2);
  const y = Number.isFinite(bounds.y) ? Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)) : Math.round(area.y + (area.height - height) / 2);
  return { x, y, width, height };
}
function resizeBounds(bounds, start, cursor, edge, minimum = { width: 1100, height: 700 }) {
  if (!EDGES.has(edge)) throw new Error('Invalid resize edge');
  const dx = Math.round(cursor.x - start.x), dy = Math.round(cursor.y - start.y);
  const next = { ...bounds };
  if (edge.includes('e')) next.width = Math.max(minimum.width, bounds.width + dx);
  if (edge.includes('s')) next.height = Math.max(minimum.height, bounds.height + dy);
  if (edge.includes('w')) { next.width = Math.max(minimum.width, bounds.width - dx); next.x = bounds.x + bounds.width - next.width; }
  if (edge.includes('n')) { next.height = Math.max(minimum.height, bounds.height - dy); next.y = bounds.y + bounds.height - next.height; }
  return next;
}
function installWindowsSurface(win, screen) {
  let normalBounds = null, timer = null, watchdog = null;
  const stopResize = () => { clearInterval(timer); clearTimeout(watchdog); timer = null; watchdog = null; };
  const isMaximized = () => normalBounds !== null;
  const toggleMaximize = () => {
    stopResize();
    if (normalBounds) { const restore = fitBoundsToWorkArea(normalBounds, screen.getDisplayMatching(win.getBounds()).workArea); normalBounds = null; win.setBounds(restore); }
    else { normalBounds = win.getBounds(); win.setBounds(screen.getDisplayMatching(normalBounds).workArea); }
    win.webContents.send('window:surface-state', { maximized: isMaximized() });
    return isMaximized();
  };
  const startResize = (edge) => {
    if (!EDGES.has(edge) || normalBounds) return false;
    stopResize();
    const bounds = win.getBounds(), start = screen.getCursorScreenPoint();
    let last = bounds;
    timer = setInterval(() => {
      if (win.isDestroyed()) return stopResize();
      const [width, height] = win.getMinimumSize();
      const next = resizeBounds(bounds, start, screen.getCursorScreenPoint(), edge, { width, height });
      if (Object.keys(next).some(key => next[key] !== last[key])) { win.setBounds(next); last = next; }
    }, 16);
    watchdog = setTimeout(stopResize, 30000);
    return true;
  };
  const displayChanged = () => { if (normalBounds && !win.isDestroyed()) win.setBounds(screen.getDisplayMatching(win.getBounds()).workArea); };
  win.on('blur', stopResize);
  win.once('closed', () => { stopResize(); screen.removeListener('display-metrics-changed', displayChanged); });
  screen.on('display-metrics-changed', displayChanged);
  return { startResize, stopResize, toggleMaximize, isMaximized, getNormalBounds: () => normalBounds || win.getBounds() };
}
module.exports = { resizeBounds, fitBoundsToWorkArea, installWindowsSurface };
