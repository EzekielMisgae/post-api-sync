const { extractNestJsEndpoints } = require('./nestjs');
const { extractExpressEndpoints } = require('./express');
const { extractHonoEndpoints, extractHonoEndpointsWithFiles } = require('./hono');

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

async function extractAllEndpoints(files, framework) {
  if (framework === 'hono') {
    return extractHonoEndpoints(files);
  }

  const endpoints = [];
  let remaining = files;

  if (framework === 'auto') {
    // Hono files are handled together so cross-file .route() mounts resolve;
    // every other file still goes through the NestJS/Express extractors.
    const hono = await extractHonoEndpointsWithFiles(files);
    endpoints.push(...hono.endpoints);
    remaining = files.filter((file) => !hono.honoFiles.has(file));
  }

  for (const file of remaining) {
    const extracted = await extractEndpoints(file, framework);
    endpoints.push(...extracted);
  }
  return endpoints;
}

module.exports = { extractEndpoints, extractAllEndpoints };
