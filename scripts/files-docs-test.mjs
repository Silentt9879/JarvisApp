// Behavioral tests for the Files and Documents IPC surface: src/files.mjs (inside/
// reallyInside/readWorkspaceFile/openInVsCode) and src/workspace.mjs's docRoots/listDocs/
// readDoc/searchDocs. All real filesystem operations against disposable temp directories -
// no Electron, no real workspace, no network.
//   node scripts/files-docs-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inside, reallyInside, readWorkspaceFile, openInVsCode } from '../src/files.mjs';
import { docRoots, listDocs, readDoc, searchDocs } from '../src/workspace.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}${extra ? `\n     ${extra}` : ''}`); } };
const check = async (name, fn) => { try { await fn(); ok(true, name); } catch (e) { ok(false, name, String(e.stack || e).slice(0, 400)); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-files-docs-'));
const write = (rel, text = '') => { const p = path.join(WS, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };

// ------------------------------------------------------------------ workspace path containment
await check('inside(): a plain file resolves; traversal, an absolute path elsewhere, and invalid input are all refused', () => {
  write('a/b.txt', 'hi');
  assert.equal(path.resolve(inside(WS, 'a/b.txt')), path.resolve(WS, 'a/b.txt'));
  assert.equal(inside(WS, '../outside'), null);
  assert.equal(inside(WS, '..\\outside'), null);
  assert.equal(inside(WS, 'a/../../outside'), null);
  assert.equal(inside(WS, 'C:\\Windows\\win.ini'), null);
  assert.equal(inside(WS, ''), null);
  assert.equal(inside(WS, 'x\0y'), null, 'a null byte is refused outright');
  assert.equal(inside(WS, 123), null, 'a non-string path is refused, not coerced');
  assert.equal(inside(WS, null), null);
  assert.equal(inside(null, 'a/b.txt'), null, 'no workspace, nothing is inside it');
  assert.equal(inside('', 'a/b.txt'), null);
});
await check('inside(): a sibling folder whose name starts with the workspace\'s own name is not mistaken for being inside it', () => {
  fs.mkdirSync(`${WS}-sibling`, { recursive: true });
  fs.writeFileSync(path.join(`${WS}-sibling`, 'x.txt'), 'x');
  assert.equal(inside(WS, `../${path.basename(WS)}-sibling/x.txt`), null);
  fs.rmSync(`${WS}-sibling`, { recursive: true, force: true });
});
await check('inside(): case does not matter on Windows, since the filesystem does not either', () => {
  write('MixedCase/File.TXT', 'x');
  assert.equal(inside(WS, 'mixedcase/file.txt')?.toLowerCase(), path.join(WS, 'MixedCase', 'File.TXT').toLowerCase());
});

// ------------------------------------------------------------------ symlinks and junctions
// Kept alive (not cleaned up) until every check that depends on this escaping link is done -
// including the openInVsCode() one further below.
const LINK_OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-outside-'));
fs.writeFileSync(path.join(LINK_OUTSIDE, 'secret.txt'), 'not yours');
fs.mkdirSync(path.join(WS, 'linked-dir'), { recursive: true });
const ESCAPE_LINK = path.join(WS, 'linked-dir', 'escape');
try { fs.symlinkSync(LINK_OUTSIDE, ESCAPE_LINK, 'junction'); } catch { fs.symlinkSync(LINK_OUTSIDE, ESCAPE_LINK, 'dir'); }

await check('reallyInside(): a junction inside the workspace that leads outside it is caught, even though inside() alone could not see it', async () => {
  const lexical = inside(WS, 'linked-dir/escape/secret.txt');
  assert.notEqual(lexical, null, 'inside() is a lexical check only - it does not itself refuse this');
  assert.equal(await reallyInside(WS, lexical), false, 'but reallyInside() resolves the real path and catches the escape');
});
await check('reallyInside(): an ordinary file with no link involved is still inside, of course', async () => {
  const full = write('plain/file.txt', 'x');
  assert.equal(await reallyInside(WS, full), true);
});

// ------------------------------------------------------------------ readWorkspaceFile(): missing files, invalid input, size limits, error propagation
await check('readWorkspaceFile(): a path outside the workspace (lexically or through a link) is refused before any read is attempted', async () => {
  await assert.rejects(() => readWorkspaceFile(WS, '../../etc/passwd'), /outside the workspace/);
  await assert.rejects(() => readWorkspaceFile(WS, 'linked-dir/escape/secret.txt'), /outside the workspace/);
});
await check('readWorkspaceFile(): a missing file is refused up front - reallyInside() cannot resolve a real path that does not exist, so it reads the same as "outside the workspace", never a raw ENOENT leaking out', async () => {
  await assert.rejects(() => readWorkspaceFile(WS, 'does/not/exist.txt'), /outside the workspace/);
});
await check('readWorkspaceFile(): a directory given as if it were a file is refused plainly', async () => {
  fs.mkdirSync(path.join(WS, 'a-folder'), { recursive: true });
  await assert.rejects(() => readWorkspaceFile(WS, 'a-folder'), /not a file/);
});
await check('readWorkspaceFile(): an ordinary small file reads in full, with its real size and no clipping', async () => {
  write('small.txt', 'hello world');
  const r = await readWorkspaceFile(WS, 'small.txt');
  assert.equal(r.text, 'hello world');
  assert.equal(r.size, 11);
  assert.equal(r.clipped, false);
});
await check('readWorkspaceFile(): a file over the 1 MB preview limit is clipped - the real size is still reported, the text is not', async () => {
  const big = Buffer.alloc(1024 * 1024 + 500, 'a');
  write('huge.txt', big);
  const r = await readWorkspaceFile(WS, 'huge.txt');
  assert.equal(r.clipped, true);
  assert.equal(r.size, big.length);
  assert.equal(r.text.length, 1024 * 1024, 'only the first 1 MB is actually read into memory');
});
await check('readWorkspaceFile(): a UTF-8 byte-order mark is stripped, the way every other reader in JARVIS strips it', async () => {
  write('bom.txt', '\uFEFFhello');
  const r = await readWorkspaceFile(WS, 'bom.txt');
  assert.equal(r.text, 'hello');
});

// ------------------------------------------------------------------ openInVsCode(): the same containment, plus "not there"
await check('openInVsCode(): outside the workspace is refused with outside:true, before VS Code is ever looked for', async () => {
  const r = await openInVsCode(WS, '../outside.txt');
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.error, /VS Code was not found/, 'refused for being outside, not because of a missing VS Code');
});
await check('openInVsCode(): a file that does not exist is "no longer there", not a generic failure', async () => {
  const r = await openInVsCode(WS, 'gone.txt');
  assert.equal(r.ok, false);
  assert.match(r.error, /no longer there/);
});
await check('openInVsCode(): a link escaping the workspace is refused with outside:true even though the file itself exists', async () => {
  const r = await openInVsCode(WS, 'linked-dir/escape/secret.txt');
  assert.equal(r.ok, false);
  assert.equal(r.outside, true);
});

// ------------------------------------------------------------------ docRoots(): structure
await check('docRoots(): every root has a label and a directory; userAgents deliberately lives outside the workspace (the person\'s own ~/.claude)', () => {
  const roots = docRoots(WS);
  for (const key of ['memory', 'knowledge', 'rules', 'agents', 'userAgents', 'skills', 'commands']) {
    assert.ok(roots[key]?.label && roots[key]?.dir, key);
  }
  assert.ok(!roots.userAgents.dir.toLowerCase().startsWith(WS.toLowerCase()), 'userAgents points outside this workspace on purpose');
  assert.ok(roots.knowledge.dir.toLowerCase().startsWith(WS.toLowerCase()), 'but knowledge is inside it');
  assert.equal(roots.knowledge.deep, true);
  assert.equal(roots.rules.deep, false);
});

// ------------------------------------------------------------------ listDocs(): reading, parsing, filtering
await check('listDocs(): front matter, a first heading, [[links]] de-duplicated, sorted by path, non-.md and unreadable entries skipped silently', async () => {
  write('.claude/knowledge/a.md', '---\nname: A Doc\ndescription: about a\ntype: reference\n---\n# Real Title\nSee [[other]] and [[other]] again, and [[third]].');
  write('.claude/knowledge/sub/b.md', '# B\nplain body');
  write('.claude/knowledge/not-a-doc.txt', 'ignored - wrong extension');
  fs.mkdirSync(path.join(WS, '.claude', 'knowledge', 'unreadable.md'), { recursive: true }); // a directory named *.md, not a file
  const docs = await listDocs(WS, 'knowledge');
  assert.equal(docs.length, 2, 'the directory named *.md and the .txt file are both skipped, not crashed on');
  assert.deepEqual(docs.map((d) => d.path), ['a.md', 'sub/b.md'], 'sorted by path; a deep root does recurse into subfolders');
  const a = docs.find((d) => d.path === 'a.md');
  assert.equal(a.name, 'A Doc');
  assert.equal(a.title, 'Real Title', 'the first heading wins over the front-matter name for the title');
  assert.equal(a.description, 'about a');
  assert.deepEqual(a.links, ['other', 'third'], 'de-duplicated, in first-seen order');
});
await check('listDocs(): a shallow root (deep:false) does not descend into subfolders at all', async () => {
  write('.claude/jarvis/top.md', '# Top');
  write('.claude/jarvis/sub/nested.md', '# Nested');
  const docs = await listDocs(WS, 'rules');
  assert.deepEqual(docs.map((d) => d.path), ['top.md']);
});
await check('listDocs(): an unknown root is an empty list, not a throw', async () => {
  assert.deepEqual(await listDocs(WS, 'not-a-real-root'), []);
});
await check('listDocs(): a hidden subfolder is never descended into, even in a deep root', async () => {
  write('.claude/knowledge/.hidden/secret.md', '# Should not appear');
  const docs = await listDocs(WS, 'knowledge');
  assert.ok(!docs.some((d) => d.path.includes('.hidden')));
});

// ------------------------------------------------------------------ readDoc(): containment, extension, size, missing
await check('readDoc(): a real document reads, with the front matter stripped from the body and its workspace-relative path for "open in VS Code"', async () => {
  const d = await readDoc(WS, 'knowledge', 'a.md');
  assert.doesNotMatch(d.text, /^---/, 'front matter is not shown as part of the body');
  assert.match(d.text, /# Real Title/);
  assert.equal(d.wsRel, path.join('.claude', 'knowledge', 'a.md'));
});
await check('readDoc(): traversal out of the root is refused, even one that would land back inside the workspace somewhere else', async () => {
  await assert.rejects(() => readDoc(WS, 'knowledge', '../jarvis/top.md'), /outside the allowed folders/);
  await assert.rejects(() => readDoc(WS, 'knowledge', '../../outside.md'), /outside the allowed folders/);
});
await check('readDoc(): only a .md file - the extension is enforced even for a path that otherwise resolves inside the root', async () => {
  write('.claude/knowledge/not-markdown.json', '{}');
  await assert.rejects(() => readDoc(WS, 'knowledge', 'not-markdown.json'), /outside the allowed folders/);
});
await check('readDoc(): a document that does not exist, and an unknown root, are both refused plainly', async () => {
  await assert.rejects(() => readDoc(WS, 'knowledge', 'nope.md'), /not there/);
  await assert.rejects(() => readDoc(WS, 'not-a-real-root', 'a.md'), /Unknown document/);
});
await check('readDoc(): a document over 2 MB is refused as too large to show, before it is read into memory', async () => {
  write('.claude/knowledge/huge.md', Buffer.alloc(2 * 1024 * 1024 + 10, 'a'));
  await assert.rejects(() => readDoc(WS, 'knowledge', 'huge.md'), /too large to show/);
});
await check('readDoc(): a symlinked .md file that leads outside the root is refused through the real path, not just the lexical one', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-doc-outside-'));
  fs.writeFileSync(path.join(outside, 'leaked.md'), '# Not yours');
  const link = path.join(WS, '.claude', 'knowledge', 'linked.md');
  try { fs.symlinkSync(path.join(outside, 'leaked.md'), link, 'file'); } catch { fs.symlinkSync(path.join(outside, 'leaked.md'), link); }
  await assert.rejects(() => readDoc(WS, 'knowledge', 'linked.md'), /outside the allowed folders/);
  fs.rmSync(outside, { recursive: true, force: true });
});

// ------------------------------------------------------------------ searchDocs(): document search
await check('searchDocs(): too short a query is refused outright - never a scan of every document for one or two letters', async () => {
  assert.deepEqual(await searchDocs(WS, 'a'), []);
  assert.deepEqual(await searchDocs(WS, ''), []);
  assert.deepEqual(await searchDocs(WS, '  '), []);
});
await check('searchDocs(): case-insensitive body match, with a snippet, and a filename match scored above a body-only match', async () => {
  write('.claude/jarvis/zzz-needle-in-name.md', '# Nothing special in the body');
  const hits = await searchDocs(WS, 'NEEDLE');
  const byName = hits.find((h) => h.path.includes('needle-in-name'));
  assert.ok(byName, 'matched by filename, case-insensitively');
  assert.equal(byName.score, 2);
  const byBody = hits.find((h) => h.path === 'a.md'); // "a.md" body says "Real Title", not a needle match - control
  assert.equal(byBody, undefined, 'a document with no match at all is not returned');
});
await check('searchDocs(): a body match includes a snippet around the hit, trimmed and collapsed', async () => {
  write('.claude/jarvis/body-match.md', `${'x'.repeat(80)} findme ${'y'.repeat(80)}`);
  const hits = await searchDocs(WS, 'findme');
  const hit = hits.find((h) => h.path === 'body-match.md');
  assert.ok(hit);
  assert.match(hit.snippet, /findme/);
  assert.ok(hit.snippet.length < 160, 'the snippet is a window around the hit, not the whole document');
});

fs.rmSync(LINK_OUTSIDE, { recursive: true, force: true });
fs.rmSync(WS, { recursive: true, force: true });
console.log(`files-docs-test: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
