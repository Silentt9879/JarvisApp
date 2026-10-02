/* JARVIS window - how a repository path is shown in a file list. Display only.

   One implementation for every list that shows a file as its name with the folder beneath:
   Changes, a History commit, a stash, a pull request, and the diff header. The folder sits
   in a right-to-left box (see .sc-file-name small) so that a long one loses its START, not
   its end - the end is the part that tells files apart.

   Right-to-left layout reorders text by the Unicode bidi rules, and a path is mostly
   "weak" characters: a leading dot (.claude) jumped to the end and showed as "claude.",
   a leading number moved (2024/q1 showed as q1/2024), and brackets flipped. So the folder
   goes in as an ISOLATED left-to-right run, a <bdi dir="ltr">, inside that box: the box
   still truncates from the left, and the text inside keeps its real order.

   Nothing is inserted into the text - no invisible marks - so what is shown, selected or
   copied is exactly the path git uses. Callers keep the original path for every action;
   this only draws it. Loaded as a plain script in the window (JV.path), and by the test
   suite through module.exports with a stand-in document. */
(function (root) {
  'use strict';

  /** The name and its folder, split at the last '/'. The pieces rejoin to the original. */
  function splitPath(filePath) {
    const p = String(filePath == null ? '' : filePath);
    const slash = p.lastIndexOf('/');
    return {
      name: slash < 0 ? p : p.slice(slash + 1),
      dir: slash > 0 ? p.slice(0, slash) : '',
    };
  }

  /**
   * Fill `node` with the name in <b> and, when there is one, the folder in `dirTag`
   * (<small> in the file lists, <code> in the diff header) holding a <bdi dir="ltr">.
   */
  function renderPath(doc, node, filePath, { dirTag = 'small' } = {}) {
    const { name, dir } = splitPath(filePath);
    const b = doc.createElement('b');
    b.textContent = name;
    node.appendChild(b);
    if (dir) {
      const box = doc.createElement(dirTag);
      const run = doc.createElement('bdi');
      run.setAttribute('dir', 'ltr');
      run.textContent = dir;
      box.appendChild(run);
      node.appendChild(box);
    }
    return node;
  }

  const api = { splitPath, renderPath };
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root && root.JV) {
    root.JV.path = {
      split: splitPath,
      render: (node, filePath, opts) => renderPath(root.document, node, filePath, opts),
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
