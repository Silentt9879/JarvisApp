// Unit test for src/active-work.mjs (the plain-English "what would stop" description shared
// by power-down's after-the-fact notice and the pre-switch warning), plus a wiring check that
// powerDown() in main.mjs actually stops task-runner jobs, Dart analysis, .NET build
// diagnostics and in-flight git remote operations - and tells the phone when it had to. No
// Electron, no real processes.
//   node scripts/power-down-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describeStoppedWork } from '../src/active-work.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}${extra ? `\n     ${extra}` : ''}`); } };
const check = (name, fn) => { try { fn(); ok(true, name); } catch (e) { ok(false, name, String(e.message || e).slice(0, 300)); } };

// ------------------------------------------------------------------ describeStoppedWork
check('nothing running: nothing to say', () => {
  assert.deepEqual(describeStoppedWork({ tasks: 0, analysis: 0, dotnetAnalysis: 0, gitRemote: 0 }), []);
  assert.deepEqual(describeStoppedWork({}), [], 'missing fields count as zero, not a throw');
  assert.deepEqual(describeStoppedWork(), [], 'no argument at all is just as safe');
});
check('one build/test run: singular wording', () => {
  assert.deepEqual(describeStoppedWork({ tasks: 1, analysis: 0, gitRemote: 0 }), ['1 build or test run']);
});
check('several build/test runs: plural wording', () => {
  assert.deepEqual(describeStoppedWork({ tasks: 3, analysis: 0, gitRemote: 0 }), ['3 build or test runs']);
});
check('Dart analysis in progress, with its count', () => {
  assert.deepEqual(describeStoppedWork({ tasks: 0, analysis: 2, gitRemote: 0 }), ['Dart analysis (2)']);
});
check('.NET build diagnostics in progress: singular and plural wording, with its count', () => {
  assert.deepEqual(describeStoppedWork({ tasks: 0, analysis: 0, dotnetAnalysis: 1, gitRemote: 0 }), ['.NET build (1)']);
  assert.deepEqual(describeStoppedWork({ tasks: 0, analysis: 0, dotnetAnalysis: 2, gitRemote: 0 }), ['.NET builds (2)']);
});
check('git operations: singular and plural wording', () => {
  assert.deepEqual(describeStoppedWork({ tasks: 0, analysis: 0, gitRemote: 1 }), ['1 git operation in progress']);
  assert.deepEqual(describeStoppedWork({ tasks: 0, analysis: 0, gitRemote: 2 }), ['2 git operations in progress']);
});
check('everything at once: all four, every time in the same order', () => {
  assert.deepEqual(
    describeStoppedWork({ tasks: 2, analysis: 1, dotnetAnalysis: 4, gitRemote: 3 }),
    ['2 build or test runs', 'Dart analysis (1)', '.NET builds (4)', '3 git operations in progress'],
  );
});

// ------------------------------------------------------------------ wiring: main.mjs
check('wiring: powerDown() stops tasks, analysis, .NET builds and remote git, and tells the phone what it stopped', () => {
  const main = fs.readFileSync(new URL('../src/main.mjs', import.meta.url), 'utf8');
  assert.match(main, /import \{ describeStoppedWork \} from '\.\/active-work\.mjs';/);
  const body = /function powerDown\(from\) \{([\s\S]*?)\n\}/.exec(main)?.[1] || '';
  assert.notEqual(body, '', 'powerDown() was found');
  assert.match(body, /const stopped = describeStoppedWork\(activeWork\(\)\);/);
  for (const call of ['shutdownTasks()', 'shutdownAnalysis()', 'shutdownDotnetAnalysis()', 'cancelAllRemotes()']) {
    assert.ok(body.includes(call), `${call} is called before the window closes`);
  }
  // It must actually run, not merely be referenced - each sits in its own try block.
  assert.match(body, /try \{ shutdownTasks\(\); \} catch/);
  assert.match(body, /try \{ shutdownAnalysis\(\); \} catch/);
  assert.match(body, /try \{ shutdownDotnetAnalysis\(\); \} catch/);
  assert.match(body, /try \{ cancelAllRemotes\(\); \} catch/);
  assert.match(body, /if \(stopped\.length\) \{[\s\S]{0,200}remote\.announce\(/, 'the phone is told, only when there was something to tell it');
  // The ordering that matters: work is stopped (and counted) BEFORE the session/web
  // apps/devices teardown that already existed, so nothing here is skipped by an earlier
  // return, and the notice reflects what was actually running at the moment of power-down.
  const stopIdx = body.indexOf('shutdownTasks()');
  const sessionIdx = body.indexOf('session?.close()');
  assert.ok(stopIdx > 0 && sessionIdx > stopIdx, 'task/analysis/remote shutdown happens before the rest of the teardown');
});
check('wiring: activeWork() (the pre-switch warning too) now counts analysis, .NET builds and git-remote work, not just chat/flutter/web/tasks', () => {
  const main = fs.readFileSync(new URL('../src/main.mjs', import.meta.url), 'utf8');
  assert.match(main, /import \{ analyzeApp, cancelAnalysis, shutdownAnalysis, runningAnalysis \} from '\.\/analysis\.mjs';/);
  assert.match(main, /import \{ analyzeDotnet, cancelDotnetAnalysis, shutdownDotnetAnalysis, runningDotnetAnalysis \} from '\.\/dotnet-analysis\.mjs';/);
  assert.match(main, /cancelAllRemotes, runningRemotes \} from '\.\/git\.mjs';/);
  const body = /function activeWork\(\) \{([\s\S]*?)\n\}/.exec(main)?.[1] || '';
  assert.match(body, /analysis = runningAnalysis\(\)/);
  assert.match(body, /dotnetAnalysis = runningDotnetAnalysis\(\)/);
  assert.match(body, /gitRemote = runningRemotes\(\)/);
  assert.match(body, /return \{ chat: busyChat, flutter, web, tasks: runningTasks\(\)\.length, analysis, dotnetAnalysis, gitRemote, remote: !!remote\.ready \};/);
});

console.log(`power-down-test: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
