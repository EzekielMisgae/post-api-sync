const path = require('path');
const fs = require('fs-extra');

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);

function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

// Resolves a relative import ('./users', './users.js', './routes') to a source file.
// Handles TypeScript ESM imports that use a .js extension for a .ts file.
function resolveImportFile(baseDir, source) {
  const base = path.isAbsolute(source) ? source : path.resolve(baseDir, source);
  const ext = path.extname(source);
  const tryFiles = [base];

  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    const stem = base.slice(0, -ext.length);
    tryFiles.push(`${stem}.ts`, `${stem}.tsx`, `${stem}${ext === '.mjs' ? '.mts' : ext === '.cjs' ? '.cts' : '.ts'}`);
  }
  if (ext === '.jsx') tryFiles.push(base.replace(/\.jsx$/, '.tsx'));

  // './posts.routes' has extname '.routes', which is not a real file extension
  if (!SOURCE_EXTENSIONS.has(ext)) {
    for (const e of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']) tryFiles.push(`${base}${e}`);
    for (const e of ['index.ts', 'index.tsx', 'index.js', 'index.jsx']) tryFiles.push(path.join(base, e));
  }

  for (const candidate of tryFiles) {
    if (isFile(candidate)) return candidate;
  }
  return null;
}

module.exports = { resolveImportFile, SOURCE_EXTENSIONS };
