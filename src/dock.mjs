// Docking a phone's own window onto JARVIS's left edge - the geometry only, no Electron, so
// it can be tested on its own. main.mjs feeds it window bounds and applies what it returns.
//
// The behaviour, Windows Snap for these two windows: drag the phone window onto JARVIS's
// left edge and let go, and it takes that edge at JARVIS's full height while JARVIS makes
// room beside it. Drag it away or close it, and JARVIS gets its old size back.

/** How close (px) the phone window's left edge must come to JARVIS's left edge to dock. */
export const SNAP_ZONE = 90;
/** Narrowest and widest a docked phone may be; and never more than this share of the area. */
export const MIN_W = 320;
export const MAX_W = 620;
export const MAX_SHARE = 0.45;

/** Would letting go here dock it? Near JARVIS's left edge and overlapping it vertically. */
export function inSnapZone(phone, area, zone = SNAP_ZONE) {
  if (!phone || !area) return false;
  const overlaps = phone.y < area.y + area.height && phone.y + phone.height > area.y;
  return overlaps && Math.abs(phone.x - area.x) <= zone;
}

/** The width a docked phone keeps: its own, within limits. */
export function dockWidth(phoneWidth, area) {
  const cap = Math.min(MAX_W, Math.round(area.width * MAX_SHARE));
  return Math.max(MIN_W, Math.min(Number(phoneWidth) || MIN_W, cap));
}

/** Docked: the phone on the left of the area, full height; JARVIS the rest. */
export function dockLayout(area, phoneWidth) {
  const width = dockWidth(phoneWidth, area);
  return {
    phone: { x: area.x, y: area.y, width, height: area.height },
    jarvis: { x: area.x + width, y: area.y, width: area.width - width, height: area.height },
    width,
  };
}

/** JARVIS was moved or resized by hand while docked: the phone follows, on its left. */
export function followLayout(jarvis, width) {
  return { x: jarvis.x - width, y: jarvis.y, width, height: jarvis.height };
}

/** The phone was widened or narrowed by hand while docked: JARVIS takes what is left. */
export function afterPhoneResize(phone, area) {
  const right = area.x + area.width;
  const x = phone.x + phone.width;
  return { x, y: area.y, width: Math.max(400, right - x), height: area.height };
}

/** Still where it was docked? A drag of more than a few px away undocks it. */
export function stillDocked(phone, docked, slack = 24) {
  return Math.abs(phone.x - docked.x) <= slack && Math.abs(phone.y - docked.y) <= slack;
}
