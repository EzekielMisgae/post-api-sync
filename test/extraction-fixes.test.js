const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const { extractAllEndpoints } = require('../src/extract');
const { mergeInsomniaCollection } = require('../src/merge/insomnia');
const { addNewEndpoints } = require('../src/merge/postman-additive');
const { buildPostmanCollection } = require('../src/collection/postman');
const { loadConfig } = require('../src/config');

async function makeProject(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'post-api-sync-fix-'));
  for (const [rel, contents] of Object.entries(files)) {
    await fs.outputFile(path.join(dir, rel), contents);
  }
  return dir;
}

async function keys(dir, rels, framework, contextRels = []) {
  const abs = (r) => path.join(dir, r);
  const endpoints = await extractAllEndpoints(rels.map(abs), framework, { contextFiles: contextRels.map(abs) });
  return endpoints.map((e) => e.key).sort();
}

function flatten(items, out = []) {
  for (const item of items || []) item.item ? flatten(item.item, out) : out.push(item);
  return out;
}

// --- Hono ---

test('hono: chained routes and chained .route() mounts are all found', async () => {
  const dir = await makeProject({
    'src/app.ts': `
      import { Hono } from 'hono';
      import { users } from './users';
      const app = new Hono().basePath('/api').route('/users', users);
      app.get('/a', (c) => c.text('')).post('/b', (c) => c.text('')).route('/again', users);
      export default app;`,
    'src/users.ts': `
      import { Hono } from 'hono';
      export const users = new Hono().get('/', (c) => c.json([])).post('/', (c) => c.json({}));`
  });
  assert.deepEqual(await keys(dir, ['src/app.ts', 'src/users.ts'], 'hono'), [
    'GET /api/a', 'GET /api/again', 'GET /api/users', 'POST /api/again', 'POST /api/b', 'POST /api/users'
  ]);
});

test('hono: mounts in an entry file outside the include globs still set the prefix', async () => {
  const dir = await makeProject({
    'src/index.ts': `
      import { Hono } from 'hono';
      import posts from './routes/posts.routes';
      const app = new Hono();
      app.route('/v1/posts', posts);
      app.get('/health', (c) => c.text('ok'));`,
    'src/routes/posts.routes.ts': `
      import { Hono } from 'hono';
      const posts = new Hono();
      posts.get('/:id', (c) => c.json({}));
      export default posts;`
  });
  // index.ts is only context: its own /health route is not reported
  assert.deepEqual(await keys(dir, ['src/routes/posts.routes.ts'], 'hono', ['src/index.ts']), ['GET /v1/posts/:id']);
});

test('hono: .on() with a non-literal path is skipped instead of producing GET /', async () => {
  const dir = await makeProject({
    'src/r.ts': `
      import { Hono } from 'hono';
      const app = new Hono();
      const P = '/x';
      app.on('GET', P, (c) => c.text(''));
      app.on(['GET', 'POST'], '/y', (c) => c.text(''));`
  });
  assert.deepEqual(await keys(dir, ['src/r.ts'], 'hono'), ['GET /y', 'POST /y']);
});

// --- Express ---

test('express: prefixes from app.use() in other files are applied, including nested routers', async () => {
  const dir = await makeProject({
    'src/app.js': `
      const express = require('express');
      const api = require('./routes');
      const app = express();
      app.use('/api', api);`,
    'src/routes/index.js': `
      const { Router } = require('express');
      const users = require('./users.routes');
      const router = Router();
      router.use('/users', auth, users);
      router.use('/orders', require('./orders.routes'));
      module.exports = router;`,
    'src/routes/users.routes.js': `
      const router = require('express').Router();
      router.get('/:id', (req, res) => res.end());
      module.exports = router;`,
    'src/routes/orders.routes.ts': `
      import { Router } from 'express';
      const router = Router();
      router.post('/', (req, res) => res.end());
      export default router;`
  });
  assert.deepEqual(
    await keys(dir, ['src/routes/users.routes.js', 'src/routes/orders.routes.ts'], 'express', ['src/app.js', 'src/routes/index.js']),
    ['GET /api/users/:id', 'POST /api/orders']
  );
});

test('express: unmounted routers keep their own paths', async () => {
  const dir = await makeProject({
    'src/routes/users.js': `
      const router = require('express').Router();
      router.get('/users', (req, res) => res.end());
      module.exports = router;`
  });
  assert.deepEqual(await keys(dir, ['src/routes/users.js'], 'express'), ['GET /users']);
});

// --- NestJS ---

test('nestjs: @Controller({ path }) and array paths are supported', async () => {
  const dir = await makeProject({
    'src/users.controller.ts': `
      import { Controller, Get, Post } from '@nestjs/common';
      @Controller({ path: 'users', version: '1' })
      export class UsersController {
        @Get(':id') one() {}
        @Post(['', 'bulk']) create() {}
      }`
  });
  assert.deepEqual(await keys(dir, ['src/users.controller.ts'], 'nestjs'), ['GET /users/:id', 'POST /users', 'POST /users/bulk']);
});

test('nestjs: DTOs imported with a .js extension are resolved', async () => {
  const dir = await makeProject({
    'src/dto/create.dto.ts': 'export class CreateDto { name: string; age?: number; }',
    'src/c.controller.ts': `
      import { Controller, Post, Body } from '@nestjs/common';
      import { CreateDto } from './dto/create.dto.js';
      @Controller('c') export class C { @Post() make(@Body() b: CreateDto) {} }`
  });
  const [endpoint] = await extractAllEndpoints([path.join(dir, 'src/c.controller.ts')], 'nestjs');
  assert.deepEqual(Object.keys(endpoint.parameters.body.properties), ['name', 'age']);
  assert.deepEqual(endpoint.parameters.body.required, ['name']);
});

// --- monorepo ---

test('monorepo: the same route in two apps is added once per app', () => {
  const config = {
    sources: { baseUrl: 'http://localhost:8000/api', appBaseUrls: { auth: 'http://localhost:8000/api', orders: 'http://localhost:8001/api' } },
    organization: { groupBy: 'folder' }
  };
  const endpoints = [
    { method: 'GET', path: '/health', key: 'GET /health', filePath: '/r/apps/auth/src/health/health.controller.ts' },
    { method: 'GET', path: '/health', key: 'GET /health', filePath: '/r/apps/orders/src/health/health.controller.ts' }
  ];
  const generated = buildPostmanCollection(endpoints, config);
  const first = addNewEndpoints(null, generated, config);
  assert.equal(first.added.length, 2);
  const second = addNewEndpoints(first.collection, generated, config);
  assert.equal(second.added.length, 0);
  assert.deepEqual(flatten(first.collection.item).map((i) => i.request.url.raw).sort(),
    ['{{baseUrl_auth}}/health', '{{baseUrl_orders}}/health']);
});

// --- Insomnia ---

test('insomnia: re-sync keeps the workspace, environment and edited requests', () => {
  const config = { sources: { baseUrl: 'http://x' }, output: { insomnia: {} }, merge: { markDeprecated: true } };
  const endpoints = [
    { method: 'POST', path: '/users', key: 'POST /users', parameters: { body: { type: 'object', properties: { name: { type: 'string' } } } } },
    { method: 'GET', path: '/users', key: 'GET /users' }
  ];
  const first = mergeInsomniaCollection(endpoints, config, null);
  const post = first.resources.find((r) => r.method === 'POST');
  post.body = { mimeType: 'application/json', text: '{"name":"edited"}' };
  first.resources.find((r) => r._type === 'environment').data.token = 'mine';

  const more = [...endpoints, { method: 'DELETE', path: '/users/:id', key: 'DELETE /users/:id' }];
  const second = mergeInsomniaCollection(more, config, JSON.parse(JSON.stringify(first)));

  const workspaceId = first.resources.find((r) => r._type === 'workspace')._id;
  const requests = second.resources.filter((r) => r._type === 'request');
  assert.equal(requests.length, 3);
  assert.ok(requests.every((r) => r.parentId === workspaceId), 'no orphaned requests');
  assert.equal(second.resources.filter((r) => r._type === 'workspace').length, 1);
  assert.equal(requests.find((r) => r.method === 'POST').body.text, '{"name":"edited"}');
  assert.equal(second.resources.find((r) => r._type === 'environment').data.token, 'mine');
});

// --- watch ---

test('watch: re-resolving an already resolved config path finds the same config', async () => {
  const dir = await makeProject({ 'apps/api/post-api-sync.config.json': '{"framework":"hono"}' });
  const first = await loadConfig('apps/api', dir);
  const again = await loadConfig(first.path, first.baseDir);
  assert.equal(again.path, first.path);
  assert.equal(again.config.framework, 'hono');
});
