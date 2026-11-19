const { buildInsomniaCollection } = require('../collection/insomnia');
const { normalizeMatchPath } = require('./postman-additive');

// Keeps the existing workspace, environments and requests as they are and adds requests
// for new endpoints. With merge.updateExisting, existing requests also get the method, URL
// and headers from code (their bodies are still kept).
function mergeInsomniaCollection(endpoints, config, existing) {
  const generated = buildInsomniaCollection(endpoints, config);
  if (!existing || !Array.isArray(existing.resources)) return generated;

  const updateExisting = !!(config.merge && config.merge.updateExisting);
  const resources = existing.resources.map((r) => ({ ...r }));
  const workspace = resources.find((r) => r._type === 'workspace');
  if (!workspace) return generated;

  const existingByKey = new Map();
  for (const req of resources) {
    if (req._type !== 'request') continue;
    const key = keyFromRequest(req);
    if (key && !existingByKey.has(key)) existingByKey.set(key, req);
  }

  const generatedRequests = generated.resources.filter((r) => r._type === 'request');
  const generatedKeys = new Set();
  for (const req of generatedRequests) {
    const key = keyFromRequest(req);
    generatedKeys.add(key);
    const match = existingByKey.get(key);
    if (!match) {
      // New requests go into the existing workspace, not the freshly generated one
      resources.push({ ...req, parentId: workspace._id });
      existingByKey.set(key, req);
    } else if (updateExisting) {
      Object.assign(match, {
        method: req.method || match.method,
        url: req.url || match.url,
        headers: mergeHeaders(req.headers || [], match.headers || [])
      });
    }
  }

  if (updateExisting && config.merge && config.merge.markDeprecated) {
    for (const [key, req] of existingByKey.entries()) {
      if (generatedKeys.has(key)) continue;
      const name = String(req.name || '');
      if (!name.startsWith('[DEPRECATED]')) req.name = `[DEPRECATED] ${name}`;
    }
  }

  // Make sure there is a baseUrl environment value without overwriting user values
  const env = resources.find((r) => r._type === 'environment' && r.parentId === workspace._id);
  const generatedEnv = generated.resources.find((r) => r._type === 'environment');
  if (env && generatedEnv) {
    env.data = { ...(generatedEnv.data || {}), ...(env.data || {}) };
  } else if (!env && generatedEnv) {
    resources.push({ ...generatedEnv, parentId: workspace._id });
  }

  return { ...existing, resources };
}

function keyFromRequest(req) {
  if (!req || !req.method || !req.url) return null;
  const url = String(req.url)
    .replace(/^\{\{\s*_\.[A-Za-z0-9_]+\s*\}\}/, '')
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '');
  return `${req.method.toUpperCase()} ${normalizeMatchPath(url)}`;
}

function mergeHeaders(codeHeaders, existingHeaders) {
  const map = new Map();
  for (const h of existingHeaders) {
    if (!h || !h.name) continue;
    map.set(h.name.toLowerCase(), h);
  }
  for (const h of codeHeaders) {
    if (!h || !h.name) continue;
    if (!map.has(h.name.toLowerCase())) map.set(h.name.toLowerCase(), h);
  }
  return Array.from(map.values());
}

module.exports = { mergeInsomniaCollection };
