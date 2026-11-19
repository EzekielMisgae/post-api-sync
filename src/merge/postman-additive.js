// Additive merge: adds requests for endpoints that are not in the collection yet and
// never modifies, renames, moves or removes anything that is already there.

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isFolder(item) {
  return !!item && Array.isArray(item.item);
}

function flattenRequests(items, out = []) {
  for (const item of items || []) {
    if (isFolder(item)) flattenRequests(item.item, out);
    else if (item && item.request) out.push(item);
  }
  return out;
}

// Path prefixes that come from base URLs, e.g. '/api' from 'http://localhost:3000/api'.
// Requests written by hand often hardcode them, so they are stripped when matching.
function basePathPrefixes(config) {
  const sources = (config && config.sources) || {};
  const urls = [sources.baseUrl, ...Object.values(sources.appBaseUrls || {})].filter(Boolean);
  const prefixes = new Set();
  for (const url of urls) {
    try {
      const pathname = new URL(String(url)).pathname.replace(/\/+$/, '');
      if (pathname && pathname !== '/') prefixes.add(pathname.toLowerCase());
    } catch {
      // not an absolute URL; nothing to strip
    }
  }
  return Array.from(prefixes);
}

function isParamSegment(segment) {
  return /^:/.test(segment) || /^\{\{.+\}\}$/.test(segment) || /^\{.+\}$/.test(segment);
}

// '/users/:id', '/users/{id}' and '/users/{{userId}}' all become '/users/:'
function normalizeMatchPath(rawPath) {
  const segments = String(rawPath || '')
    .split(/[?#]/)[0]
    .split('/')
    .filter(Boolean)
    .map((segment) => (isParamSegment(segment) ? ':' : segment.toLowerCase()));
  return `/${segments.join('/')}`;
}

function pathFromPostmanUrl(url) {
  if (!url) return '/';
  const raw = typeof url === 'string' ? url : url.raw;
  if (raw) {
    return String(raw)
      .trim()
      .replace(/^\{\{[^}]+\}\}/, '') // {{baseUrl}}, {{baseUrl_orders}}, {{host}}, ...
      .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, ''); // http://localhost:3000
  }
  if (Array.isArray(url.path)) {
    return `/${url.path.map((p) => (typeof p === 'string' ? p : (p && p.value) || '')).join('/')}`;
  }
  return '/';
}

function matchKeysForPath(method, rawPath, prefixes) {
  const m = String(method || 'GET').toUpperCase();
  const normalized = normalizeMatchPath(rawPath);
  const keys = new Set([`${m} ${normalized}`]);
  for (const prefix of prefixes) {
    if (normalized === prefix) keys.add(`${m} /`);
    else if (normalized.startsWith(`${prefix}/`)) keys.add(`${m} ${normalized.slice(prefix.length)}`);
  }
  return keys;
}

// '{{baseUrl_orders}}/x' -> 'baseurl_orders'; anything else -> '' (no app scope)
function requestScope(item) {
  const request = item.request || {};
  const url = typeof request === 'string' ? request : request.url;
  const raw = typeof url === 'string' ? url : url && url.raw;
  const match = String(raw || '').trim().match(/^\{\{\s*(baseUrl_[A-Za-z0-9_]+)\s*\}\}/i);
  return match ? match[1].toLowerCase() : '';
}

function requestMatchKeys(item, prefixes) {
  const request = item.request || {};
  const method = typeof request === 'string' ? 'GET' : request.method;
  const url = typeof request === 'string' ? request : request.url;
  return matchKeysForPath(method, pathFromPostmanUrl(url), prefixes);
}

function findOrCreateFolder(items, name) {
  const wanted = String(name).toLowerCase();
  let folder = items.find((item) => isFolder(item) && String(item.name || '').toLowerCase() === wanted);
  if (!folder) {
    folder = { name, item: [] };
    items.push(folder);
  }
  return folder;
}

// Walks the generated tree, yielding each request together with its folder names.
function* walkGenerated(items, folderPath = []) {
  for (const item of items || []) {
    if (isFolder(item)) yield* walkGenerated(item.item, [...folderPath, item.name]);
    else if (item && item.request) yield { item, folderPath };
  }
}

function addNewEndpoints(existingCollection, generatedCollection, config) {
  const prefixes = basePathPrefixes(config);
  const collection = existingCollection ? clone(existingCollection) : { info: clone(generatedCollection.info) };
  if (!Array.isArray(collection.item)) collection.item = [];

  const existingRequests = flattenRequests(collection.item);
  const knownScoped = new Set(); // 'scope|GET /x'
  const knownAny = new Set(); // 'GET /x' in any scope
  const knownUnscoped = new Set(); // 'GET /x' with a plain {{baseUrl}} / hardcoded host
  const remember = (keys, scope) => {
    for (const key of keys) {
      knownScoped.add(`${scope}|${key}`);
      knownAny.add(key);
      if (!scope) knownUnscoped.add(key);
    }
  };
  for (const item of existingRequests) remember(requestMatchKeys(item, prefixes), requestScope(item));

  const generatedItems = [...walkGenerated(generatedCollection.item)];
  // How many generated requests share a method+path (e.g. GET /health in several apps)
  const primaryCounts = new Map();
  for (const { item } of generatedItems) {
    const primary = [...requestMatchKeys(item, prefixes)][0];
    primaryCounts.set(primary, (primaryCounts.get(primary) || 0) + 1);
  }

  const added = [];
  const generatedKeys = new Set();
  for (const { item, folderPath } of generatedItems) {
    const keys = [...requestMatchKeys(item, prefixes)];
    const scope = requestScope(item);
    for (const key of keys) generatedKeys.add(key);

    const exists = scope
      ? keys.some((key) => knownScoped.has(`${scope}|${key}`)) ||
        // a hand-made request using plain {{baseUrl}} still counts when the route is unambiguous
        (primaryCounts.get(keys[0]) === 1 && keys.some((key) => knownUnscoped.has(key)))
      : keys.some((key) => knownAny.has(key));
    if (exists) continue;

    let target = collection.item;
    for (const name of folderPath) target = findOrCreateFolder(target, name).item;
    target.push(clone(item));
    added.push({ name: item.name, method: item.request.method, folder: folderPath.join(' / ') });
    remember(keys, scope);
  }

  // Only add variables that are missing; never overwrite values the user has set.
  const variables = Array.isArray(collection.variable) ? collection.variable : [];
  const existingVarKeys = new Set(variables.map((v) => v && v.key));
  const addedVariables = [];
  for (const variable of generatedCollection.variable || []) {
    if (existingVarKeys.has(variable.key)) continue;
    variables.push(clone(variable));
    addedVariables.push(variable.key);
  }
  if (variables.length) collection.variable = variables;

  // Requests in the collection that no longer match any endpoint in code (reported, not touched)
  const stale = existingRequests
    .filter((item) => ![...requestMatchKeys(item, prefixes)].some((key) => generatedKeys.has(key)))
    .map((item) => item.name);

  return { collection, added, addedVariables, stale };
}

module.exports = { addNewEndpoints, normalizeMatchPath, pathFromPostmanUrl };
