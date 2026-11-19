const { extractNestJsEndpoints } = require('./nestjs');
const { extractExpressEndpoints, computeExpressFilePrefixes } = require('./express');
const { extractHonoEndpointsWithFiles } = require('./hono');
const { joinPaths, normalizePath, toKey } = require('../utils');

async function extractEndpoints(filePath, framework) {
  if (framework === 'nestjs') {
    try {
      return await extractNestJsEndpoints(filePath);
    } catch {
      return [];
    }
  }
  if (framework === 'express') {
    try {
      return await extractExpressEndpoints(filePath);
    } catch {
      return [];
    }
  }
  if (framework === 'hono') return [];
  // auto: try NestJS then Express
  let nest = [];
  let exp = [];
  try {
    nest = await extractNestJsEndpoints(filePath);
  } catch {
    nest = [];
  }
  try {
    exp = await extractExpressEndpoints(filePath);
  } catch {
    exp = [];
  }
  const map = new Map();
  for (const e of [...nest, ...exp]) map.set(e.key, e);
  return Array.from(map.values());
}

// Applies prefixes from `app.use('/prefix', router)` calls made in other files.
function applyFilePrefixes(endpoints, filePrefixes) {
  const out = [];
  for (const endpoint of endpoints) {
    const prefixes = filePrefixes.get(endpoint.filePath);
    if (!prefixes || !prefixes.size || endpoint.protocol) {
      out.push(endpoint);
      continue;
    }
    for (const prefix of prefixes) {
      if (!prefix) {
        out.push(endpoint);
        continue;
      }
      const fullPath = normalizePath(joinPaths(prefix, endpoint.path));
      const generatedDescription = endpoint.description === `${endpoint.method} ${endpoint.path}`;
      out.push({
        ...endpoint,
        path: fullPath,
        description: generatedDescription ? `${endpoint.method} ${fullPath}` : endpoint.description,
        key: toKey(endpoint.method, fullPath)
      });
    }
  }
  return out;
}

// `contextFiles` are other source files (e.g. src/app.ts, src/index.ts) that are only read
// to find where routers are mounted; their own endpoints are not reported.
async function extractAllEndpoints(files, framework, { contextFiles = [] } = {}) {
  if (framework === 'hono') {
    const hono = await extractHonoEndpointsWithFiles(files, contextFiles);
    return hono.endpoints;
  }

  const endpoints = [];
  let remaining = files;

  if (framework === 'auto') {
    // Hono files are handled together so cross-file .route() mounts resolve;
    // every other file still goes through the NestJS/Express extractors.
    const hono = await extractHonoEndpointsWithFiles(files, contextFiles);
    endpoints.push(...hono.endpoints);
    remaining = files.filter((file) => !hono.honoFiles.has(file));
  }

  const extracted = [];
  for (const file of remaining) {
    extracted.push(...await extractEndpoints(file, framework));
  }

  if (framework !== 'nestjs' && remaining.length) {
    const filePrefixes = await computeExpressFilePrefixes([...remaining, ...contextFiles]);
    endpoints.push(...applyFilePrefixes(extracted, filePrefixes));
  } else {
    endpoints.push(...extracted);
  }
  return endpoints;
}

module.exports = { extractEndpoints, extractAllEndpoints };
