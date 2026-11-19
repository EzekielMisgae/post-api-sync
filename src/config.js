const path = require('path');
const Module = require('module');
const { pathToFileURL } = require('url');
const fs = require('fs-extra');

const ALWAYS_EXCLUDE = ['**/node_modules/**', '**/dist/**', '**/build/**', '**/*.d.ts'];

const DEFAULT_INCLUDE = [
  'src/**/routes.{js,ts}',
  'src/**/*.routes.{js,ts}',
  'src/**/*.controller.ts',
  'src/**/*router.{js,ts}',
  'apps/**/src/**/routes.{js,ts}',
  'apps/**/src/**/*.routes.{js,ts}',
  'apps/**/src/**/*.controller.ts',
  'apps/**/src/**/*router.{js,ts}',
  'services/**/src/**/routes.{js,ts}',
  'services/**/src/**/*.routes.{js,ts}',
  'services/**/src/**/*.controller.ts',
  'services/**/src/**/*router.{js,ts}',
  'libs/**/src/**/routes.{js,ts}',
  'libs/**/src/**/*.routes.{js,ts}',
  'libs/**/src/**/*.controller.ts',
  'libs/**/src/**/*router.{js,ts}'
];

const DEFAULT_CONFIG = {
  framework: 'auto',
  sources: {
    include: DEFAULT_INCLUDE,
    exclude: ['**/*.spec.ts', '**/*.test.ts', 'node_modules/**', 'dist/**', 'build/**'],
    baseUrl: 'http://localhost:3000/api'
  },
  output: {
    postman: {
      enabled: true,
      outputPath: './collections/postman-collection.json'
    },
    insomnia: {
      enabled: true,
      outputPath: './collections/insomnia-collection.json'
    }
  },
  watch: {
    enabled: true,
    debounce: 300
  },
  merge: {
    markDeprecated: true
  },
  organization: {
    groupBy: 'folder'
  }
};

const CONFIG_FILENAMES = [
  'post-api-sync.config.js',
  'post-api-sync.config.cjs',
  'post-api-sync.config.mjs',
  'post-api-sync.config.json'
];

async function findConfigInDir(dir) {
  for (const name of CONFIG_FILENAMES) {
    const candidate = path.resolve(dir, name);
    if (await fs.pathExists(candidate)) return candidate;
  }
  return path.resolve(dir, CONFIG_FILENAMES[0]);
}

async function resolveConfigPath(configPath, baseDir) {
  let cwd = baseDir ? path.resolve(baseDir) : process.cwd();

  if (configPath) {
    const abs = path.isAbsolute(configPath) ? configPath : path.resolve(cwd, configPath);
    if (await fs.pathExists(abs)) {
      const stat = await fs.stat(abs);
      if (stat.isDirectory()) {
        cwd = abs;
        return { path: await findConfigInDir(cwd), baseDir: cwd };
      }
      return { path: abs, baseDir: path.dirname(abs) };
    }
    if (!path.extname(abs)) {
      cwd = abs;
      return { path: await findConfigInDir(cwd), baseDir: cwd };
    }
    return { path: abs, baseDir: cwd };
  }

  return { path: await findConfigInDir(cwd), baseDir: cwd };
}

async function loadConfig(configPath, baseDir) {
  const resolved = await resolveConfigPath(configPath, baseDir);
  if (await fs.pathExists(resolved.path)) {
    const userConfig = await importConfigFile(resolved.path);
    return { config: mergeDeep(DEFAULT_CONFIG, userConfig), path: resolved.path, baseDir: resolved.baseDir };
  }
  return { config: DEFAULT_CONFIG, path: resolved.path, baseDir: resolved.baseDir };
}

async function importConfigFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json') return fs.readJson(filePath);
  if (ext === '.mjs') return importEsm(filePath);
  if (ext === '.cjs') return compileCommonJs(filePath);

  // .js: its module type depends on the nearest package.json "type" field.
  // Config files written by older versions of `init` always use `module.exports`,
  // so fall back to CommonJS when an ESM-scoped file turns out to be CommonJS.
  if (await isEsmScope(path.dirname(filePath))) {
    try {
      return await importEsm(filePath);
    } catch (err) {
      if (!isCommonJsInEsmError(err)) throw err;
      return compileCommonJs(filePath);
    }
  }

  try {
    return compileCommonJs(filePath);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    try {
      return await importEsm(filePath);
    } catch {
      throw new Error(
        `Could not load ${path.basename(filePath)}: it uses ESM syntax in a CommonJS package. ` +
        'Rename it to post-api-sync.config.mjs, or use module.exports.'
      );
    }
  }
}

async function importEsm(filePath) {
  const mod = await import(`${pathToFileURL(filePath).href}?t=${Date.now()}`);
  return mod.default !== undefined ? mod.default : mod;
}

// Evaluates a file as CommonJS regardless of the surrounding package's "type".
function compileCommonJs(filePath) {
  const code = fs.readFileSync(filePath, 'utf8');
  const mod = new Module(filePath, module);
  mod.filename = filePath;
  mod.paths = Module._nodeModulePaths(path.dirname(filePath));
  mod._compile(code, filePath);
  const out = mod.exports;
  return out && out.__esModule && out.default !== undefined ? out.default : out;
}

function isCommonJsInEsmError(err) {
  return err instanceof ReferenceError && /\b(module|exports|require) is not defined\b/.test(err.message);
}

async function isEsmScope(dir) {
  let current = dir;
  while (true) {
    const pkgPath = path.join(current, 'package.json');
    if (await fs.pathExists(pkgPath)) {
      try {
        const pkg = await fs.readJson(pkgPath);
        return pkg.type === 'module';
      } catch {
        return false;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function mergeDeep(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) {
    return override === undefined ? base : override;
  }
  if (typeof base === 'object' && base && typeof override === 'object' && override) {
    const out = { ...base };
    for (const key of Object.keys(override)) {
      out[key] = mergeDeep(base[key], override[key]);
    }
    return out;
  }
  return override === undefined ? base : override;
}

function ensureAbsolute(pathLike, baseDir) {
  if (!pathLike) return pathLike;
  if (path.isAbsolute(pathLike)) return pathLike;
  const cwd = baseDir ? path.resolve(baseDir) : process.cwd();
  return path.resolve(cwd, pathLike);
}

const GLOB_CHARS = /[*?[\]{}!]/;

function looksLikeGlob(pattern) {
  return GLOB_CHARS.test(pattern);
}

function normalizePattern(entry, baseDir, isInclude) {
  if (!entry) return [];
  const trimmed = entry.trim();
  if (!trimmed) return [];

  if (looksLikeGlob(trimmed)) return [trimmed];

  const cwd = baseDir ? path.resolve(baseDir) : process.cwd();
  const abs = path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);

  if (fs.existsSync(abs)) {
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      return [path.join(trimmed, isInclude ? '**/*.{ts,js,tsx,jsx}' : '**')];
    }
    return [trimmed];
  }

  // Treat bare extensions like "ts" or ".ts"
  if (!trimmed.includes('/') && !trimmed.includes('\\')) {
    const ext = trimmed.startsWith('.') ? trimmed.slice(1) : trimmed;
    if (ext) return [isInclude ? `**/*.${ext}` : `**/*.${ext}`];
  }

  return [trimmed];
}

function normalizeIncludePatterns(patterns, baseDir) {
  const list = Array.isArray(patterns) ? patterns : [patterns];
  return list.flatMap((p) => normalizePattern(p, baseDir, true));
}

function normalizeExcludePatterns(patterns, baseDir) {
  const list = Array.isArray(patterns) ? patterns : [patterns];
  const normalized = list.flatMap((p) => normalizePattern(p, baseDir, false));
  return Array.from(new Set([...normalized, ...ALWAYS_EXCLUDE]));
}

module.exports = {
  DEFAULT_INCLUDE,
  DEFAULT_CONFIG,
  resolveConfigPath,
  loadConfig,
  isEsmScope,
  ensureAbsolute,
  normalizeIncludePatterns,
  normalizeExcludePatterns,
  ALWAYS_EXCLUDE
};
