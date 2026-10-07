// Unit test for deploy-finished alerts (src/deploys.mjs) and the voice resampler.
//   node scripts/deploy-test.mjs
import { createDeployWatcher, DEPLOY } from '../src/deploys.mjs';
import { toMono16k } from '../src/voice.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

// ------------------------------------------------------------------ what counts as a deploy
for (const c of [
  'firebase deploy --only hosting', 'npm run deploy', 'dotnet publish -c Release -o out', 'flutter build appbundle --release',
  'flutter build apk', 'eas submit -p android', 'vercel --prod', 'az webapp deploy --src-path app.zip', 'docker push acme/api:1.4',
  'git push heroku main', 'gcloud run deploy api --source .',
]) ok(DEPLOY.test(c), `a deploy: ${c}`);
for (const c of ['dotnet build', 'flutter run', 'git push origin main', 'npm test', 'flutter build --help-not-a-target', 'vercel dev']) {
  ok(!DEPLOY.test(c), `not a deploy: ${c}`);
}

// ------------------------------------------------------------------ the alert
{
  let t = 1000;
  const sent = [];
  const on = { v: true };
  const w = createDeployWatcher({ enabled: () => on.v, notify: (x) => sent.push(x), now: () => t });

  w.event({ kind: 'tool_use', id: 'a', name: 'Bash', detail: 'dotnet build' });
  w.event({ kind: 'tool_result', id: 'a', preview: 'Build succeeded.' });
  ok(!sent.length, 'an ordinary command is not announced');

  w.event({ kind: 'tool_use', id: 'b', name: 'PowerShell', detail: 'dotnet publish -c Release' });
  t += 95000;
  w.event({ kind: 'tool_result', id: 'b', isError: false, preview: 'Restoring...\n  0 Warning(s)\n  0 Error(s)\n  api -> C:\\out\\' });
  ok(sent[0]?.title === '🚀 Deploy finished after 1m 35s' && sent[0].body.startsWith('$ dotnet publish') && sent[0].body.includes('api -> C:\\out\\'),
    'a finished deploy says so, how long it took, the command and the last lines');

  w.event({ kind: 'tool_use', id: 'c', name: 'Bash', detail: 'firebase deploy' });
  t += 4000;
  w.event({ kind: 'tool_result', id: 'c', isError: true, preview: 'Error: HTTP 403, permission denied\nExit code 1' });
  ok(sent[1]?.title.startsWith('❌ Deploy failed'), 'a failing deploy says it failed');

  w.event({ kind: 'tool_use', id: 'd', name: 'Bash', detail: 'npm run deploy' });
  w.event({ kind: 'tool_result', id: 'd', preview: 'deploy step failed: bucket not found' });
  ok(sent[2]?.title.startsWith('❌'), 'a deploy that printed a failure but exited 0 is still a failure');

  w.event({ kind: 'tool_use', id: 'e', name: 'Bash', detail: 'npm run deploy' });
  t += 100;
  w.event({ kind: 'tool_result', id: 'e', preview: 'Command running in background with ID: x1' });
  ok(sent.length === 3, 'a deploy sent to the background is not announced as finished');

  on.v = false;
  w.event({ kind: 'tool_use', id: 'f', name: 'Bash', detail: 'firebase deploy' });
  w.event({ kind: 'tool_result', id: 'f', preview: 'Deploy complete!' });
  ok(sent.length === 3, 'alerts off: nothing is sent');

  w.event({ kind: 'tool_use', id: 'g', name: 'Bash', detail: 'firebase deploy' });
  w.event({ kind: 'status', state: 'closed' });
  ok(w._running() === 0, 'a closed session forgets deploys that will never report');
}

// ------------------------------------------------------------------ resampling for Whisper
{
  const a = new Float32Array(48000).map((_, i) => Math.sin(i / 10));
  const b = new Float32Array(48000).map((_, i) => Math.sin(i / 10));
  const out = toMono16k([a, b], 48000);
  ok(out.length === 16000, '48 kHz stereo becomes 16 kHz: one third the samples');
  ok(Math.abs(out[100] - (a[300] + a[301] + a[302]) / 3) < 1e-6, 'each sample is the mean of three, both channels mixed');
  ok(toMono16k([new Float32Array(44100)], 44100).length === 16000, 'any other rate is interpolated to 16 kHz');
}

console.log(`deploy-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
