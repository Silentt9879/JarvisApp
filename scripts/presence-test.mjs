// Unit test for the group status board (src/presence.mjs), against a fake group - no network.
//   node scripts/presence-test.mjs
import { parseBoard, renderBoard, sameName, createPresence } from '../src/presence.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

const T = Date.UTC(2026, 9, 3, 12, 43);

// ------------------------------------------------------------------ the board's text
{
  const text = renderBoard('Our PCs', 'Work-PC', 'asleep', T);
  const both = renderBoard(text, 'Home-PC', 'awake', T);
  ok(both === 'Our PCs\n🟢 Home-PC · awake · 2026-10-03 12:43Z\n💤 Work-PC · asleep · 2026-10-03 12:43Z', 'board: lines sorted by name, the user\'s own text kept');
  const b = parseBoard(both);
  ok(b.pcs.length === 2 && b.pcs[0].name === 'Home-PC' && b.pcs[0].at === T && b.other[0] === 'Our PCs', 'board: read back as written');
  ok(renderBoard(both, 'home pc', 'asleep', T).includes('💤 home pc') && parseBoard(renderBoard(both, 'home pc', 'asleep', T)).pcs.length === 2, 'board: a PC\'s line is replaced, not added twice');
  ok(!renderBoard(both, 'Work-PC', null, T).includes('Work-PC'), 'board: clearing takes the line off');
  ok(sameName('Work-PC1', 'work pc1') && !sameName('Work-PC', 'Work-PC1') && !sameName('', ''), 'names: loose match, but Work-PC is not Work-PC1');
}

// ------------------------------------------------------------------ a fake group, two PCs
function fakeGroup({ canWrite = true } = {}) {
  const g = { description: '', writes: 0 };
  g.api = async (_token, method, body) => {
    if (method === 'getChat') return { ok: true, result: { description: g.description } };
    if (method === 'setChatDescription') {
      if (!canWrite) return { ok: false, error: 'Bad Request: not enough rights to change chat description' };
      g.writes++;
      g.description = body.description;
      return { ok: true, result: true };
    }
    return { ok: false, error: 'unexpected' };
  };
  return g;
}
const pc = (g, name, now = () => T, logs = []) => createPresence({ cfg: () => ({ token: 't', groupId: '-1', name }), api: g.api, log: (...a) => logs.push(a.join(' ')), now, settleMs: 1 });

{
  const g = fakeGroup();
  const home = pc(g, 'Home-PC');
  const work = pc(g, 'Work-PC');
  await home.set('awake');
  await work.set('asleep');
  const seen = await home.peers();
  ok(seen.length === 1 && seen[0].name === 'Work-PC' && seen[0].state === 'asleep', 'presence: each PC sees the other, and its state');
  ok((await work.peers())[0]?.state === 'awake', 'presence: both ways');
  await work.clear();
  ok((await home.peers()).length === 0, 'presence: a PC that quit is gone');

  // A line not refreshed for a while is a PC that is off.
  const later = pc(g, 'Home-PC', () => T + 13 * 60 * 1000);
  await pc(g, 'Work-PC').set('awake');
  ok((await later.peers()).length === 0, 'presence: a stale line counts as not there');
  home.stop(); work.stop(); later.stop();
}

{
  // Two PCs writing at the same moment: the read-back puts a lost line back.
  const g = fakeGroup();
  const home = pc(g, 'Home-PC');
  const work = pc(g, 'Work-PC');
  await Promise.all([home.set('awake'), work.set('awake')]);
  const names = parseBoard(g.description).pcs.map((p) => p.name).sort();
  ok(names.join() === 'Home-PC,Work-PC', 'presence: simultaneous writes both end up on the board');
  home.stop(); work.stop();
}

{
  // No admin rights: said once in the log, never thrown.
  const g = fakeGroup({ canWrite: false });
  const logs = [];
  const home = pc(g, 'Home-PC', () => T, logs);
  ok(await home.set('awake') === false, 'presence: without rights the write fails quietly');
  await home.set('asleep');
  ok(logs.filter((l) => /Change group info/.test(l)).length === 1, 'presence: and the log says what to fix, once');
  home.stop();
}

{
  // No group set up: nothing at all happens.
  const calls = [];
  const none = createPresence({ cfg: () => ({ token: 't', groupId: null, name: 'Home-PC' }), api: async (...a) => { calls.push(a); return { ok: true }; } });
  await none.set('awake');
  ok(!calls.length && (await none.peers()).length === 0 && !none.active, 'presence: without a group it stays out of the way');
  none.stop();
}

console.log(`presence-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
