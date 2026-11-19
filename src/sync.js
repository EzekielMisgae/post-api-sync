const fs = require('fs-extra');
const fg = require('fast-glob');
const path = require('path');
const { loadConfig, ensureAbsolute, normalizeIncludePatterns, normalizeExcludePatterns, ALWAYS_EXCLUDE, DEFAULT_INCLUDE } = require('./config');
const { extractAllEndpoints } = require('./extract');
const { mergePostmanCollection } = require('./merge/postman');
const { addNewEndpoints } = require('./merge/postman-additive');
const { buildPostmanCollection } = require('./collection/postman');
const { mergeInsomniaCollection } = require('./merge/insomnia');
const postmanCloud = require('./sync/postman-cloud');
const { info, warn, success, error } = require('./log');
const { isJsOrTs } = require('./utils');

function reportAdditive(label, result, dryRun, verbose = false) {
  const verb = dryRun ? 'would add' : 'adding';
  if (!result.added.length) {
    info(`${label}: no new endpoints.`);
  } else {
    info(`${label}: ${verb} ${result.added.length} new request(s):`);
    for (const a of result.added) info(`  + ${a.name}${a.folder ? `  [${a.folder}]` : ''}`);
  }
  if (result.addedVariables.length) {
    info(`${label}: ${verb} missing variable(s): ${result.addedVariables.join(', ')}`);
  }
  if (result.stale.length) {
    warn(`${label}: ${result.stale.length} request(s) don't match any endpoint in code (left as is):`);
    const shown = verbose ? result.stale : result.stale.slice(0, 20);
    for (const s of shown) warn(`  ? ${s.name}  (${s.method} ${s.url})`);
    if (shown.length < result.stale.length) warn(`  ... and ${result.stale.length - shown.length} more (use --verbose to list all)`);
  }
}

async function syncOnce({ configPath, baseDir, postmanKey, postmanId, dryRun = false, verbose = false } = {}) {
  try {
    const { config, baseDir: resolvedBase } = await loadConfig(configPath, baseDir);
    const cwd = resolvedBase || process.cwd();
    // Use CLI args, env vars, or config values
    const pmKey = postmanKey || process.env.POSTMAN_API_KEY || (config.output && config.output.postman && config.output.postman.apiKey);
    const pmId = postmanId || process.env.POSTMAN_COLLECTION_ID || (config.output && config.output.postman && config.output.postman.collectionId);

    const include = normalizeIncludePatterns(config.sources.include || [], cwd);
    const exclude = Array.from(new Set([
      ...normalizeExcludePatterns(config.sources.exclude || [], cwd),
      ...ALWAYS_EXCLUDE
    ]));

    let files = await fg(include, { ignore: exclude, dot: false, cwd, absolute: true });
    let jsTsFiles = files.filter(isJsOrTs);

    if (jsTsFiles.length === 0) {
      const fallbackInclude = normalizeIncludePatterns(DEFAULT_INCLUDE, cwd);
      files = await fg(fallbackInclude, { ignore: exclude, dot: false, cwd, absolute: true });
      jsTsFiles = files.filter(isJsOrTs);
      if (jsTsFiles.length > 0) {
        warn('No files matched configured include patterns. Falling back to default route/controller presets.');
      }
    }

    if (jsTsFiles.length === 0) {
      jsTsFiles = await autoDiscoverEndpointFiles(cwd, exclude);
      if (jsTsFiles.length > 0) {
        warn(`No files matched configured globs. Auto-discovered ${jsTsFiles.length} route/controller candidate file(s).`);
      }
    }

    info(`Scanning ${jsTsFiles.length} file(s)...`);
    if (jsTsFiles.length === 0) {
      warn(`No files matched. cwd=${cwd}`);
      warn(`include=${include.join(', ')}`);
      warn(`exclude=${exclude.join(', ')}`);
    }

    let extracted = [];
    let extractionFailed = false;
    try {
      const contextFiles = await findMountContextFiles(cwd, exclude, jsTsFiles);
      extracted = await extractAllEndpoints(jsTsFiles, config.framework, { contextFiles });
      if (extracted.length === 0 && config.framework && config.framework !== 'auto') {
        const fallback = await extractAllEndpoints(jsTsFiles, 'auto', { contextFiles });
        if (fallback.length) {
          warn(`No endpoints found for framework=${config.framework}. Falling back to auto-detect.`);
          extracted = fallback;
        }
      }
    } catch (err) {
      warn(`Extraction failed: ${err.message || err}`);
      extractionFailed = true;
    }

    // Same method+path in two different apps (apps/auth, apps/orders) are different endpoints
    const unique = new Map();
    for (const e of extracted) unique.set(`${appOf(e.filePath)}|${e.key}`, e);

    let finalEndpoints = Array.from(unique.values());
    if (config.sources && config.sources.includeRpc === false) {
      // gRPC methods and @MessagePattern/@EventPattern handlers can't be called from Postman
      finalEndpoints = finalEndpoints.filter((e) => !e.protocol);
    }
    info(`Found ${finalEndpoints.length} endpoint(s)`);

    if (extractionFailed) {
      error('Endpoint extraction failed, so collections were left untouched.');
      process.exitCode = 1;
      return;
    }

    const updateExisting = !!(config.merge && config.merge.updateExisting);

    if (config.output && config.output.postman && config.output.postman.enabled) {
      const outPath = ensureAbsolute(config.output.postman.outputPath, cwd);
      const existing = await readJsonIfExists(outPath);
      const relOut = path.relative(process.cwd(), outPath);

      if (updateExisting) {
        const merged = mergePostmanCollection(finalEndpoints, config, existing);
        if (dryRun) {
          info(`[dry run] Would rewrite ${relOut} (merge.updateExisting is on)`);
        } else {
          await fs.outputJson(outPath, merged, { spaces: 2 });
          success(`Postman collection written to ${relOut}`);
        }
      } else {
        const generated = buildPostmanCollection(finalEndpoints, config);
        const result = addNewEndpoints(existing, generated, config);
        reportAdditive(`Local collection (${relOut})`, result, dryRun, verbose);
        if (!dryRun && (!existing || result.added.length || result.addedVariables.length)) {
          await fs.outputJson(outPath, result.collection, { spaces: 2 });
          success(`Postman collection written to ${relOut}`);
        }
      }

      if (pmKey && pmId) {
        try {
          info(`Fetching Postman collection ${pmId}...`);
          const remote = await postmanCloud.fetchCollection(pmKey, pmId);
          const generated = buildPostmanCollection(finalEndpoints, config);
          const result = addNewEndpoints(remote, generated, config);
          reportAdditive(`Postman collection "${(remote.info && remote.info.name) || pmId}"`, result, dryRun, verbose);

          if (dryRun) {
            info('[dry run] Postman was not modified.');
          } else if (result.added.length || result.addedVariables.length) {
            await postmanCloud.updateCollection(pmKey, pmId, result.collection);
            success(`Added ${result.added.length} request(s) to Postman. Existing requests were not changed.`);
          } else {
            success('Postman collection is already up to date; nothing was sent.');
          }
        } catch (err) {
          error(`Failed to sync to Postman: ${err.message}`);
          process.exitCode = 1;
        }
      } else if (pmKey || pmId) {
        // Partial keys present
        warn('Skipping Postman Cloud sync: Missing API Key or Collection ID.');
        if (!pmKey) warn('  -> POSTMAN_API_KEY is missing');
        if (!pmId) warn('  -> POSTMAN_COLLECTION_ID is missing');
      }
    }

    if (dryRun && config.output && config.output.insomnia && config.output.insomnia.enabled) {
      info('[dry run] Skipping Insomnia output.');
    } else if (config.output && config.output.insomnia && config.output.insomnia.enabled) {
      const outPath = ensureAbsolute(config.output.insomnia.outputPath, cwd);
      const existing = await readJsonIfExists(outPath);
      const merged = mergeInsomniaCollection(finalEndpoints, config, existing);
      await fs.outputJson(outPath, merged, { spaces: 2 });
      success(`Insomnia collection written to ${path.relative(process.cwd(), outPath)}`);
    }
  } catch (err) {
    error(err.stack || err.message || String(err));
    process.exitCode = 1;
  }
}

// Files outside the include globs that mount routers (app.use('/api', router), app.route('/x', x)),
// typically src/app.ts or src/index.ts. They're read only to get route prefixes right.
async function findMountContextFiles(cwd, exclude, scannedFiles) {
  const scanned = new Set(scannedFiles);
  const candidates = await fg(['**/*.{ts,js,mts,cts,mjs,cjs}'], {
    cwd,
    absolute: true,
    dot: false,
    ignore: [...exclude, '**/*.d.ts', '**/*.{spec,test}.{ts,js}', '**/coverage/**', '**/.next/**']
  });
  const out = [];
  for (const file of candidates) {
    if (scanned.has(file)) continue;
    try {
      const stat = await fs.stat(file);
      if (stat.size > 512 * 1024) continue;
      const text = await fs.readFile(file, 'utf8');
      if (/\.(use|route)\s*\(/.test(text)) out.push(file);
    } catch {
      // unreadable file; ignore
    }
  }
  return out;
}

async function autoDiscoverEndpointFiles(cwd, exclude) {
  const discovered = await fg(['**/*.{ts,js,tsx,jsx}'], {
    cwd,
    absolute: true,
    dot: false,
    ignore: exclude
  });

  const candidates = discovered.filter((file) => {
    const normalized = file.replace(/\\/g, '/').toLowerCase();
    const base = path.basename(normalized);

    if (!isJsOrTs(file)) return false;
    if (base.endsWith('.d.ts') || base.endsWith('.d.tsx')) return false;

    if (/(^|\.)(routes?|router|controller)\.(t|j)sx?$/.test(base)) return true;
    if (/grpc.*controller\.(t|j)sx?$/.test(base)) return true;
    if (/\/routes?\//.test(normalized) && /\.(t|j)sx?$/.test(base)) return true;
    if (/\/controllers?\//.test(normalized) && /\.(t|j)sx?$/.test(base)) return true;

    return false;
  });

  // Keep deterministic order and remove duplicates
  return Array.from(new Set(candidates)).sort();
}

function appOf(filePath) {
  const match = String(filePath || '').replace(/\\/g, '/').match(/\/(?:apps|services)\/([^/]+)\//i);
  return match ? match[1].toLowerCase() : '';
}

async function readJsonIfExists(filePath) {
  if (await fs.pathExists(filePath)) {
    try {
      return await fs.readJson(filePath);
    } catch (err) {
      warn(`Failed to read existing collection at ${filePath}: ${err.message || err}`);
      return null;
    }
  }
  return null;
}

module.exports = { syncOnce };
