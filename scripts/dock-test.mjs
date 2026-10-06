// Docking a phone window onto JARVIS's left edge (src/dock.mjs): the geometry, no windows.
// Run: node scripts/dock-test.mjs
import assert from 'node:assert/strict';
import { inSnapZone, dockWidth, dockLayout, followLayout, afterPhoneResize, stillDocked, SNAP_ZONE, MIN_W, MAX_W } from '../src/dock.mjs';

let passed = 0;
const step = (name, fn) => { fn(); passed += 1; console.log(`  ok  ${name}`); };

// A maximized JARVIS on a 1920x1080 screen with a 40 px taskbar: the work area.
const area = { x: 0, y: 0, width: 1920, height: 1040 };
const phone = (x, y = 60, width = 440, height = 900) => ({ x, y, width, height });

step('let go near the left edge, overlapping JARVIS: docks', () => {
  assert.equal(inSnapZone(phone(0), area), true);
  assert.equal(inSnapZone(phone(SNAP_ZONE), area), true);
  assert.equal(inSnapZone(phone(-40), area), true, 'a little past the edge counts');
});

step('anywhere else: does not', () => {
  assert.equal(inSnapZone(phone(SNAP_ZONE + 1), area), false);
  assert.equal(inSnapZone(phone(700), area), false, 'the middle of JARVIS');
  assert.equal(inSnapZone(phone(0, 1100), area), false, 'below JARVIS (another monitor)');
  assert.equal(inSnapZone(phone(0), null), false, 'JARVIS hidden in the tray');
});

step('a JARVIS window that is not maximized: its own left edge', () => {
  const jarvis = { x: 500, y: 100, width: 1200, height: 800 };
  assert.equal(inSnapZone(phone(520, 120), jarvis), true);
  assert.equal(inSnapZone(phone(0, 120), jarvis), false);
});

step('the docked layout: phone left at full height, JARVIS the rest, no gap or overlap', () => {
  const l = dockLayout(area, 440);
  assert.deepEqual(l.phone, { x: 0, y: 0, width: 440, height: 1040 });
  assert.deepEqual(l.jarvis, { x: 440, y: 0, width: 1480, height: 1040 });
  assert.equal(l.phone.x + l.phone.width, l.jarvis.x);
  assert.equal(l.phone.width + l.jarvis.width, area.width);
});

step('the phone keeps its own width, within limits', () => {
  assert.equal(dockWidth(440, area), 440);
  assert.equal(dockWidth(200, area), MIN_W);
  assert.equal(dockWidth(1200, area), MAX_W);
  assert.equal(dockWidth(900, { x: 0, y: 0, width: 1000, height: 800 }), 450, 'never more than 45% of a small screen');
});

step('JARVIS moved by hand while docked: the phone follows on its left', () => {
  assert.deepEqual(followLayout({ x: 600, y: 50, width: 1200, height: 900 }, 440), { x: 160, y: 50, width: 440, height: 900 });
});

step('the phone widened by hand while docked: JARVIS takes what is left', () => {
  assert.deepEqual(afterPhoneResize({ x: 0, y: 0, width: 520, height: 1040 }, area), { x: 520, y: 0, width: 1400, height: 1040 });
});

step('dragged away undocks; a nudge does not', () => {
  const docked = { x: 0, y: 0 };
  assert.equal(stillDocked({ x: 10, y: 5 }, docked), true);
  assert.equal(stillDocked({ x: 300, y: 5 }, docked), false);
  assert.equal(stillDocked({ x: 0, y: 200 }, docked), false);
});

console.log(`dock-test: all ${passed} checks passed`);
