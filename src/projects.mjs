// Project starters: a new folder with the files a good start needs, a CLAUDE.md that tells Claude
// Code what the project is for, and a git repository when git is installed. Flutter and .NET
// templates use their own tools when those are installed, and say so when they are not.
import fs from 'node:fs';
import path from 'node:path';

export const TEMPLATES = {
  empty: { label: 'Empty folder', blurb: 'A README and a CLAUDE.md, nothing else.', tool: null },
  node: { label: 'Node web server', blurb: 'A small web server you start with node. No packages to install.', tool: null },
  python: { label: 'Python script', blurb: 'A main.py with a clear entry point.', tool: null },
  flutter: { label: 'Flutter app', blurb: 'A Flutter app. Needs Flutter installed on this PC.', tool: 'flutter' },
  dotnet: { label: '.NET web API', blurb: 'A .NET web API. Needs the .NET SDK installed on this PC.', tool: 'dotnet' },
};

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** A folder name a person can read and Windows accepts. */
export function checkName(name) {
  const n = String(name ?? '').trim();
  if (!n) return { ok: false, error: 'Give the project a name.' };
  if (n.length > 60) return { ok: false, error: 'Keep the name under 60 characters.' };
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]*$/.test(n) || /[. ]$/.test(n)) return { ok: false, error: 'Use letters, numbers, spaces, dashes or underscores.' };
  if (RESERVED.test(n)) return { ok: false, error: 'That name is reserved by Windows. Pick another.' };
  return { ok: true, value: n };
}

/** A lower-case identifier for tools that want one (Flutter's package name, npm's name). */
export function identifierOf(name) {
  let id = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!/^[a-z]/.test(id)) id = `app_${id}`;
  return id.slice(0, 40).replace(/_+$/, '') || 'app';
}

export function claudeMd(name, template) {
  const what = TEMPLATES[template]?.label || 'Project';
  return [
    `# ${name}`,
    '',
    `${what}. Created with JARVIS.`,
    '',
    '## What this project is for',
    '',
    'Describe the goal in a few sentences, so Claude Code knows what good work looks like here.',
    '',
    '## Rules for Claude',
    '',
    '- Keep changes small and explain them in plain words.',
    '- Ask before deleting files or changing anything outside this folder.',
    '- Run the project after a change and say what you saw.',
    '',
  ].join('\n');
}

const GITIGNORE = {
  node: 'node_modules/\n.env\n',
  python: '__pycache__/\n.venv/\n.env\n',
  flutter: '.dart_tool/\nbuild/\n.flutter-plugins\n.flutter-plugins-dependencies\n',
  dotnet: 'bin/\nobj/\n.vs/\n',
  empty: '.env\n',
};

/** The files a template writes itself (the tool-based ones add theirs when the tool runs). */
export function filesFor(template, name) {
  const id = identifierOf(name);
  const files = {
    'README.md': `# ${name}\n\nWhat this is, and how to run it.\n`,
    'CLAUDE.md': claudeMd(name, template),
    '.gitignore': GITIGNORE[template] || GITIGNORE.empty,
  };
  if (template === 'node') {
    files['package.json'] = `${JSON.stringify({ name: id, version: '0.1.0', private: true, type: 'module', scripts: { start: 'node server.mjs' } }, null, 2)}\n`;
    files['server.mjs'] = [
      "import http from 'node:http';",
      '',
      `const port = Number(process.env.PORT) || 3000;`,
      "const server = http.createServer((req, res) => {",
      "  if (req.url === '/api/health') {",
      "    res.writeHead(200, { 'Content-Type': 'application/json' });",
      "    res.end(JSON.stringify({ ok: true }));",
      '    return;',
      '  }',
      "  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });",
      `  res.end('Hello from ${name.replace(/'/g, '')}\\n');`,
      '});',
      "server.listen(port, () => console.log(`Running at http://localhost:${port}`));",
      '',
    ].join('\n');
  }
  if (template === 'python') {
    files['main.py'] = [
      'def main() -> None:',
      `    print("Hello from ${name.replace(/"/g, '')}")`,
      '',
      '',
      "if __name__ == '__main__':",
      '    main()',
      '',
    ].join('\n');
    files['requirements.txt'] = '# Packages this project needs, one per line.\n';
  }
  return files;
}

/**
 * Create the project. `run(file, args, opts)` runs a command (runCommand from updates.mjs), and
 * `hasTool(name)` says whether a command is installed. Never throws: problems come back as
 * { ok: false, error } with the folder left as it was found, when possible.
 */
export async function createProject({ parent, name, template, run, hasTool, timeoutMs = 5 * 60 * 1000 }) {
  const n = checkName(name);
  if (!n.ok) return n;
  if (!TEMPLATES[template]) return { ok: false, error: 'Pick a starter first.' };
  if (!parent || !fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) return { ok: false, error: 'Pick a folder to put the project in.' };
  const target = path.join(parent, n.value);
  if (fs.existsSync(target)) return { ok: false, error: `A folder called "${n.value}" is already there. Pick another name.` };

  const notes = [];
  fs.mkdirSync(target);
  try {
    for (const [rel, text] of Object.entries(filesFor(template, n.value))) fs.writeFileSync(path.join(target, rel), text);
  } catch (e) {
    fs.rmSync(target, { recursive: true, force: true });
    return { ok: false, error: `Could not write the files: ${e.message}` };
  }

  const tool = TEMPLATES[template].tool;
  if (tool) {
    if (await hasTool(tool)) {
      const args = tool === 'flutter'
        ? ['create', '--project-name', identifierOf(n.value), '.']
        : ['new', 'webapi', '--output', '.'];
      const r = await run(tool, args, { cwd: target, timeoutMs });
      if (!r.ok) notes.push(`${tool} did not finish, so only the basic files are here. Its message: ${String(r.output || '').trim().split('\n').slice(-1)[0] || 'none'}`);
    } else {
      notes.push(`${tool === 'flutter' ? 'Flutter' : '.NET'} is not installed on this PC, so only the basic files were made. Install it, then run the starter again in this folder.`);
    }
  }

  if (await hasTool('git')) {
    const r = await run('git', ['init', '-q'], { cwd: target, timeoutMs: 60000 });
    if (!r.ok) notes.push('The folder is not a git repository yet (git init did not run).');
  } else {
    notes.push('Git is not installed, so the folder is not a repository yet.');
  }

  return { ok: true, path: target, name: n.value, notes };
}
