const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const { extractAllEndpoints } = require('../src/extract');
const { buildPostmanCollection } = require('../src/collection/postman');
const { mergePostmanCollection } = require('../src/merge/postman');
const { loadConfig } = require('../src/config');

async function makeProject(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'post-api-sync-'));
  for (const [rel, contents] of Object.entries(files)) {
    await fs.outputFile(path.join(dir, rel), contents);
  }
  return dir;
}

async function extract(dir, rels, framework = 'auto') {
  const endpoints = await extractAllEndpoints(rels.map((r) => path.join(dir, r)), framework);
  return endpoints.map((e) => e.key).sort();
}

function flatten(items, out = []) {
  for (const item of items) item.item ? flatten(item.item, out) : out.push(item);
  return out;
}

// --- auto mode must not let look-alike calls hide real endpoints ---

test('auto: NestJS controller with a Map#get call keeps its endpoints', async () => {
  const dir = await makeProject({
    'src/users/users.controller.ts': `
      import { Body, Controller, Get, Param, Post } from '@nestjs/common';
      const cache = new Map();
      @Controller('users')
      export class UsersController {
        @Get(':id') findOne(@Param('id') id: string) { return cache.get('all'); }
        @Post() create(@Body() dto: any) { return dto; }
      }`
  });
  assert.deepEqual(await extract(dir, ['src/users/users.controller.ts']), ['GET /users/:id', 'POST /users']);
});

test('express: non-router .get()/.delete() calls are not routes', async () => {
  const dir = await makeProject({
    'src/routes/users.js': `
      const router = require('express').Router();
      const cache = new Map();
      const params = new URLSearchParams();
      router.get('/:id', (req, res) => res.json(cache.get('/stats')));
      params.delete('/q');
      module.exports = router;`
  });
  assert.deepEqual(await extract(dir, ['src/routes/users.js'], 'express'), ['GET /:id']);
});

test('express: routers created via imports, destructured Router, or typed params are detected', async () => {
  const dir = await makeProject({
    'src/a.ts': `
      import { Router as R } from 'express';
      const users = R();
      users.post('/users', (req, res) => res.end());`,
    'src/b.js': `
      const { Router } = require('express');
      const items = Router();
      items.route('/items').get((req, res) => res.end()).put((req, res) => res.end());`,
    'src/c.ts': `
      import type { Router } from 'express';
      export function register(r: Router) { r.patch('/things/:id', () => {}); }`
  });
  assert.deepEqual(
    await extract(dir, ['src/a.ts', 'src/b.js', 'src/c.ts'], 'express'),
    ['GET /items', 'PATCH /things/:id', 'POST /users', 'PUT /items']
  );
});

test('auto: mixed repo keeps both Hono and NestJS endpoints', async () => {
  const dir = await makeProject({
    'src/app.ts': `
      import { Hono } from 'hono';
      import { posts } from './posts.routes';
      const app = new Hono();
      const api = app.basePath('/api');
      api.route('/posts', posts);
      const q = new URLSearchParams();
      q.get('/nope');`,
    'src/posts.routes.ts': `
      import { Hono } from 'hono';
      export const posts = new Hono();
      posts.get('/:id', (c) => c.json({}));`,
    'src/users.controller.ts': `
      import { Controller, Get } from '@nestjs/common';
      @Controller('users')
      export class UsersController { @Get() list() { return []; } }`
  });
  assert.deepEqual(
    await extract(dir, ['src/app.ts', 'src/posts.routes.ts', 'src/users.controller.ts']),
    ['GET /api/posts/:id', 'GET /users']
  );
});

test('hono: routers typed as Hono params are detected', async () => {
  const dir = await makeProject({
    'src/register.ts': `
      import type { Hono } from 'hono';
      export function register(app: Hono) { app.delete('/sessions/:id', (c) => c.body(null)); }`
  });
  assert.deepEqual(await extract(dir, ['src/register.ts'], 'hono'), ['DELETE /sessions/:id']);
});

// --- path params must be Postman path variables, not undefined {{vars}} ---

test('postman: path params use :param syntax with matching url.variable', () => {
  const collection = buildPostmanCollection(
    [{ method: 'GET', path: '/users/:id/posts/{postId}', key: 'GET /users/:id/posts/{postId}' }],
    { sources: { baseUrl: 'http://localhost:3000' }, organization: { groupBy: 'tags' } }
  );
  const [item] = flatten(collection.item);
  assert.equal(item.request.url.raw, '{{baseUrl}}/users/:id/posts/:postId');
  assert.deepEqual(item.request.url.path, ['users', ':id', 'posts', ':postId']);
  assert.deepEqual(item.request.url.variable.map((v) => v.key), ['id', 'postId']);
  assert.ok(!item.request.url.raw.includes('{{id}}'));
});

test('postman merge: collections generated with legacy {{param}} URLs still match', () => {
  const config = { sources: { baseUrl: 'http://x' }, organization: { groupBy: 'tags' }, merge: { markDeprecated: true } };
  const endpoints = [{ method: 'GET', path: '/users/:id', key: 'GET /users/:id' }];
  const existing = buildPostmanCollection(endpoints, config);
  const legacy = flatten(existing.item)[0];
  legacy.request.url.raw = '{{baseUrl}}/users/{{id}}';
  legacy.event = [{ listen: 'test', script: { exec: ['pm.test("ok", () => {})'] } }];

  const merged = flatten(mergePostmanCollection(endpoints, config, existing).item);
  assert.equal(merged.length, 1, 'no duplicate or [DEPRECATED] copy');
  assert.equal(merged[0].request.url.raw, '{{baseUrl}}/users/:id');
  assert.ok(merged[0].event, 'test scripts preserved');
});

// --- config loading in ESM and CommonJS packages ---

const CONFIG_BODY = '{ framework: "hono", sources: { baseUrl: "http://esm.test" } }';

test('config: module.exports config inside a "type": "module" package', async () => {
  const dir = await makeProject({
    'package.json': '{"type":"module"}',
    'post-api-sync.config.js': `module.exports = ${CONFIG_BODY};`
  });
  const { config } = await loadConfig(undefined, dir);
  assert.equal(config.sources.baseUrl, 'http://esm.test');
  assert.equal(config.framework, 'hono');
});

test('config: export default config inside a "type": "module" package', async () => {
  const dir = await makeProject({
    'package.json': '{"type":"module"}',
    'post-api-sync.config.js': `export default ${CONFIG_BODY};`
  });
  const { config } = await loadConfig(undefined, dir);
  assert.equal(config.sources.baseUrl, 'http://esm.test');
});

test('config: .mjs, .cjs and .json configs are discovered', async () => {
  for (const [name, body] of [
    ['post-api-sync.config.mjs', `export default ${CONFIG_BODY};`],
    ['post-api-sync.config.cjs', `module.exports = ${CONFIG_BODY};`],
    ['post-api-sync.config.json', JSON.stringify({ sources: { baseUrl: 'http://esm.test' } })]
  ]) {
    const dir = await makeProject({ 'package.json': '{}', [name]: body });
    const { config, path: loadedFrom } = await loadConfig(undefined, dir);
    assert.equal(path.basename(loadedFrom), name);
    assert.equal(config.sources.baseUrl, 'http://esm.test', name);
  }
});

test('config: plain CommonJS config still works', async () => {
  const dir = await makeProject({
    'package.json': '{}',
    'post-api-sync.config.js': `const base = require('./base.cjs'); module.exports = { sources: { baseUrl: base } };`,
    'base.cjs': 'module.exports = "http://cjs.test";'
  });
  const { config } = await loadConfig(undefined, dir);
  assert.equal(config.sources.baseUrl, 'http://cjs.test');
});
