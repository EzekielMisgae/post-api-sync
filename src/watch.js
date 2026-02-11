const chokidar = require('chokidar');
const { loadConfig, normalizeIncludePatterns, normalizeExcludePatterns, ALWAYS_EXCLUDE } = require('./config');
const { syncOnce } = require('./sync');
const { info } = require('./log');

async function watchMode({ configPath, baseDir, postmanKey, postmanId } = {}) {
  const { config, baseDir: resolvedBase } = await loadConfig(configPath, baseDir);
  const cwd = resolvedBase || process.cwd();
  const include = normalizeIncludePatterns(config.sources.include || [], cwd);
  const exclude = Array.from(new Set([
    ...normalizeExcludePatterns(config.sources.exclude || [], cwd),
    ...ALWAYS_EXCLUDE
  ]));
  const debounceMs = (config.watch && config.watch.debounce) || 300;

  info(`Watching for changes...`);

  let timer = null;
  const trigger = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      syncOnce({ configPath, baseDir: cwd, postmanKey, postmanId });
    }, debounceMs);
  };

  const watcher = chokidar.watch(include, {
    ignored: exclude,
    ignoreInitial: true,
    cwd
  });

  watcher.on('add', trigger);
  watcher.on('change', trigger);
  watcher.on('unlink', trigger);
}

module.exports = { watchMode };
