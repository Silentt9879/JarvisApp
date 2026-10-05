// Unit test for the git-assist size handling: a large change set is CONDENSED to the action's
// budget instead of refused ("413 KB of diff - too much to send", 2026-10-05).
// No model is called and no git runs. Run: node scripts/gitai-test.mjs
import assert from 'node:assert/strict';
import { measure, condenseDiff, budgetFor } from '../src/gitai.mjs';

const fileDiff = (path, added, { removed = 0, body = (i) => `  line ${i} of ${path} with some code text here;` } = {}) => {
  const lines = [];
  for (let i = 0; i < removed; i++) lines.push(`-${body(i)}`);
  for (let i = 0; i < added; i++) lines.push(`+${body(i)}`);
  return `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,${removed} +1,${added} @@\n${lines.join('\n')}\n`;
};
const binary = (path) => `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..3333333\nBinary files /dev/null and b/${path} differ\n`;

// Today's shape: 53 staged files - two images, a lockfile, many small files, a few huge ones,
// and a credential buried at the END of a huge file (the part that gets cut).
const secretValue = 'sup3rS3cretValue99';
const sections = [binary('assets/images/spin_wheel/mascot.png'), binary('assets/images/spin_wheel/stage_bg.jpg'),
  fileDiff('pubspec.lock', 400)];
for (let i = 0; i < 46; i++) sections.push(fileDiff(`lib/small_${i}.dart`, 12));
sections.push(fileDiff('lib/huge_a.dart', 2600));
sections.push(fileDiff('lib/huge_b.dart', 2400, { removed: 300 }));
sections.push(fileDiff('test/huge_test.dart', 2200));
sections.push(fileDiff('lib/config.dart', 2000).replace(/\n$/, `\n+  const password = "${secretValue}";\n`));
const big = sections.join('');
const paths = [...big.matchAll(/^diff --git a\/(.+?) b\//gm)].map((m) => m[1]);
assert.equal(paths.length, 53);
assert.ok(Buffer.byteLength(big) > 400 * 1024, `fixture should be over the old 400 KB cap, is ${Math.round(Buffer.byteLength(big) / 1024)} KB`);

// 1. Generate message on it: condensed, not refused.
const parts = [{ file: null, text: big }, ...paths.map((p) => ({ file: p, text: '' }))];
const budget = budgetFor('commitMessage');
const m = measure(parts, { budget });
assert.equal(m.refuses, false, 'a big commit must not be refused any more');
assert.ok(m.condensed, 'it says it was condensed');
assert.ok(m.condensed.fromBytes > 400 * 1024);
assert.ok(m.bytes <= budget + 8 * 1024, `sent ${m.bytes} bytes for a ${budget} budget`);
assert.equal(m.tooLarge, false, 'a condensed commit message needs no "send it anyway" confirmation');
assert.match(m.summary, /shortened from \d+ KB/);

// Every file is still named, with counts; binary and generated files are named only.
for (const p of paths) assert.ok(m.text.includes(p), `${p} is listed`);
assert.match(m.text, /assets\/images\/spin_wheel\/mascot\.png {2}\+0 -0 {2}\(binary - not shown\)/);
assert.match(m.text, /pubspec\.lock {2}\+400 -0 {2}\(generated - not shown\)/);
assert.ok(!m.text.includes('line 1 of pubspec.lock'), 'generated file content is not sent');
assert.match(m.text, /lib\/huge_b\.dart {2}\+2400 -300/);
assert.match(m.text, /^NOTE FROM JARVIS: these changes/);

// Small files whole; huge files cut with a marker that says how much is hidden.
assert.ok(m.text.includes('line 11 of lib/small_7.dart'), 'a small file is sent whole');
assert.match(m.text, /\.\.\. \(lib\/huge_a\.dart: \d+ more changed lines not shown\)/);

// The secret sits in the cut part, yet the scan (over the FULL text) still found it, and its
// value is not in what is sent.
assert.ok(m.secrets.includes('credential assignment'), 'secret found even though its file was shortened');
assert.ok(!m.text.includes(secretValue), 'secret value never sent');

// 2. Under budget: untouched.
const small = fileDiff('lib/one.dart', 20);
const s = measure([{ file: null, text: small }, { file: 'lib/one.dart', text: '' }], { budget });
assert.equal(s.condensed, null);
assert.equal(s.text.trimEnd(), small.trimEnd(), 'an under-budget diff is sent exactly as it is');

// 3. A review gets a bigger budget than a commit message, and still fits under the hard cap.
const r = measure(parts, { budget: budgetFor('reviewChanges') });
assert.equal(r.refuses, false);
assert.ok(r.bytes > m.bytes, 'review sends more than a commit message');
assert.ok(r.bytes <= budgetFor('reviewChanges') + 8 * 1024);

// 4. Text that is not a git diff (a conflict's BASE / OURS / THEIRS) is cut, not refused.
const conflict = `===== BASE =====\n${'x'.repeat(80).concat('\n').repeat(4000)}`;
const c = condenseDiff(conflict, 32 * 1024);
assert.ok(Buffer.byteLength(c.text) <= 32 * 1024 + 2048);
assert.match(c.text, /more changed lines? not shown|NOTE FROM JARVIS/);

// 5. No budget = the old behaviour (measure only), for callers that pass none.
const raw = measure(parts);
assert.equal(raw.condensed, null);
assert.equal(raw.refuses, true);

console.log('gitai-test: all assertions passed', `(53 files, ${Math.round(Buffer.byteLength(big) / 1024)} KB -> ${Math.round(m.bytes / 1024)} KB for a commit message, ${Math.round(r.bytes / 1024)} KB for a review)`);
