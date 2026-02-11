const { extractNestJsEndpoints } = require('./nestjs');
const { extractExpressEndpoints } = require('./express');
const { extractHonoEndpoints } = require('./hono');

async function extractEndpoints(filePath, framework) {
  if (framework === 'nestjs') return extractNestJsEndpoints(filePath);
  if (framework === 'express') return extractExpressEndpoints(filePath);
  if (framework === 'hono') return [];
  // auto: try NestJS then Express
  const nest = await extractNestJsEndpoints(filePath);
  const exp = await extractExpressEndpoints(filePath);
  const map = new Map();
  for (const e of [...nest, ...exp]) map.set(e.key, e);
  return Array.from(map.values());
}

async function extractAllEndpoints(files, framework) {
  if (framework === 'hono') {
    return extractHonoEndpoints(files);
  }

  if (framework === 'auto') {
    const hono = await extractHonoEndpoints(files);
    if (hono.length) return hono;
  }

  const endpoints = [];
  for (const file of files) {
    const extracted = await extractEndpoints(file, framework);
    endpoints.push(...extracted);
  }
  return endpoints;
}

module.exports = { extractEndpoints, extractAllEndpoints };
