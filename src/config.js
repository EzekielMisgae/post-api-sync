const path = require('path');
const fs = require('fs-extra');

const ALWAYS_EXCLUDE = ['**/node_modules/**', '**/dist/**', '**/build/**', '**/*.d.ts'];

const DEFAULT_CONFIG = {
  framework: 'auto',
  sources: {
    include: ['src/**/routes.ts', 'src/**/*.routes.ts', 'src/**/*.controller.ts'],
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

async function resolveConfigPath(configPath, baseDir) {
  let cwd = baseDir ? path.resolve(baseDir) : process.cwd();

  if (configPath) {
    const abs = path.isAbsolute(configPath) ? configPath : path.resolve(cwd, configPath);
    if (await fs.pathExists(abs)) {
      const stat = await fs.stat(abs);
      if (stat.isDirectory()) {
        cwd = abs;
        return { path: path.resolve(cwd, 'post-api-sync.config.js'), baseDir: cwd };
      }
      return { path: abs, baseDir: path.dirname(abs) };
    }
    if (!path.extname(abs)) {
      cwd = abs;
      return { path: path.resolve(cwd, 'post-api-sync.config.js'), baseDir: cwd };
    }
    return { path: abs, baseDir: cwd };
  }

  return { path: path.resolve(cwd, 'post-api-sync.config.js'), baseDir: cwd };
}

async function loadConfig(configPath, baseDir) {
  const resolved = await resolveConfigPath(configPath, baseDir);
  if (await fs.pathExists(resolved.path)) {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const userConfig = require(resolved.path);
    return { config: mergeDeep(DEFAULT_CONFIG, userConfig), path: resolved.path, baseDir: resolved.baseDir };
  }
  return { config: DEFAULT_CONFIG, path: resolved.path, baseDir: resolved.baseDir };
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
  DEFAULT_CONFIG,
  resolveConfigPath,
  loadConfig,
  ensureAbsolute,
  normalizeIncludePatterns,
  normalizeExcludePatterns,
  ALWAYS_EXCLUDE
};
