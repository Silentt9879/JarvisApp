// Plain-English description of work in progress that a restart, a quit or a power-down would
// interrupt - built from the same counts (workspaces:busy's activeWork()) either way, so the
// pre-switch warning and power-down's own after-the-fact notice never drift apart.
export function describeStoppedWork(work = {}) {
  const stopped = [];
  if (work.tasks) stopped.push(`${work.tasks} build or test run${work.tasks === 1 ? '' : 's'}`);
  if (work.analysis) stopped.push(`Dart analysis (${work.analysis})`);
  if (work.dotnetAnalysis) stopped.push(`.NET build${work.dotnetAnalysis === 1 ? '' : 's'} (${work.dotnetAnalysis})`);
  if (work.gitRemote) stopped.push(`${work.gitRemote} git operation${work.gitRemote === 1 ? '' : 's'} in progress`);
  return stopped;
}
