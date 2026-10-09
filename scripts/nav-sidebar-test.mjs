// Nav sidebar: static checks against index.html and styles.css - the same plain-text-regex
// approach notes-test.mjs's own "wiring" section already uses. No real browser layout engine
// runs here (this harness has no CSS cascade/media-query evaluation), so this file proves the
// markup and the stylesheet rules are present and correctly shaped, never that a real window
// actually renders at a given pixel width - that is Windows-GUI-only (see nav-sidebar-manual-
// test instructions alongside the fix report).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0; const fails = [];
const check = (n, c, extra) => {
  if (c) { pass += 1; console.log('PASS  ' + n); }
  else { fails.push(n); console.log('FAIL  ' + n + (extra ? '\n        ' + String(extra).slice(0, 300) : '')); }
};
const APP = process.env.P9_APP || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/');
const read = (p) => fs.readFileSync(p, 'utf8');

const html = read(`${APP}/src/renderer/index.html`);
const css = read(`${APP}/src/renderer/styles.css`);

// ------------------------------------------------------------------ accessible tooltips

const navButtons = [
  ['navChat', 'Chat'], ['navCommand', 'Overview'], ['navProjects', 'Projects'],
  ['navSource', 'GitHub Desktop'], ['navDevices', 'Devices'], ['navCore', 'AI Core'],
  ['navNotes', 'Notes'], ['navFiles', 'Files'], ['navTasks', 'Clickup'], ['navAgents', 'Agents'],
  ['navKne', 'Knowledge Notes'], ['navTools', 'Tools &amp; Skills'],
];
for (const [id, label] of navButtons) {
  const m = new RegExp(`<button id="${id}"[^>]*>`).exec(html);
  check(`${id} has a title attribute naming it ("${label}") - the hover tooltip once only its icon remains`,
    !!m && m[0].includes(`title="${label}"`), m && m[0]);
}

// ------------------------------------------------------------------ the 980px auto-collapse

const mediaBlock = (() => {
  const start = css.indexOf('@media (max-width: 980px)');
  if (start < 0) return '';
  const openBrace = css.indexOf('{', start);
  let depth = 0;
  for (let i = openBrace; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') { depth -= 1; if (depth === 0) return css.slice(start, i + 1); }
  }
  return '';
})();
check('the 980px breakpoint exists at all', mediaBlock.length > 0);

check('.nav actually shrinks at this breakpoint (both width AND flex-basis) - not the old '
  + '"width: auto" alone, which a flex item with flex: 0 0 228px ignores entirely',
  /\.nav\s*\{[^}]*width:\s*56px[^}]*flex-basis:\s*56px/.test(mediaBlock)
  || /\.nav\s*\{[^}]*flex-basis:\s*56px[^}]*width:\s*56px/.test(mediaBlock),
  mediaBlock);
check('the old, broken "width: auto" rule for .nav is gone from this breakpoint',
  !/\.nav\s*\{[^}]*width:\s*auto/.test(mediaBlock));

check('button labels (the <span> text) are hidden at this breakpoint, leaving only icons',
  /\.nav-list button\s*>\s*span[^{]*\{[^}]*display:\s*none/.test(mediaBlock));
check('the section label ("More") is hidden at this breakpoint too',
  /\.nav-sec\s*\{[^}]*display:\s*none/.test(mediaBlock) || /,\s*\.nav-sec\s*\{[^}]*display:\s*none/.test(mediaBlock));

check('nav-list buttons are centered (icons centered in the compact rail, not left-stuck in empty space)',
  /\.nav-list button\s*\{[^}]*justify-content:\s*center/.test(mediaBlock));
check('the brand row is centered too, so the logo sits in the middle of the narrow rail',
  /\.brand\s*\{[^}]*justify-content:\s*center/.test(mediaBlock));

// ------------------------------------------------------------------ nothing else disturbed

check('the manual collapse toggle (body.nav-collapsed) is untouched - still collapses .nav to 56px',
  /body\.nav-collapsed \.nav \{[^}]*width:\s*56px[^}]*flex-basis:\s*56px/.test(css));
check('the main column still grows to fill whatever width .nav gives up (flex: 1, unchanged)',
  /\.col\s*\{[^}]*flex:\s*1/.test(css));
check('the nav-toggle button itself is not hidden at this breakpoint - it still exists, just repositioned',
  !/\.nav-toggle\s*\{[^}]*display:\s*none/.test(mediaBlock));

console.log(`\nnav-sidebar-test: ${pass} passed, ${fails.length} failed`);
process.exitCode = fails.length ? 1 : 0;
