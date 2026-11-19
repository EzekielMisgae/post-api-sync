const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const { addNewEndpoints } = require('../src/merge/postman-additive');
const { buildPostmanCollection } = require('../src/collection/postman');
const { syncOnce } = require('../src/sync');

const CONFIG = {
  sources: { baseUrl: 'http://localhost:3000/api' },
  organization: { groupBy: 'tags' },
  merge: { markDeprecated: true }
};

function flatten(items, out = []) {
  for (const item of items || []) item.item ? flatten(item.item, out) : out.push(item);
  return out;
}

function userCollection() {
  // A collection the user maintains by hand, with custom bodies, scripts and URL styles
  return {
    info: { _postman_id: 'abc', name: 'My API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json', updatedAt: '2026-01-01' },
    variable: [{ key: 'baseUrl', value: 'https://staging.example.com/api' }, { key: 'authToken', value: 'secret' }],
    item: [
      {
        name: 'Users',
        id: 'folder-1',
        auth: { type: 'bearer' },
        item: [
          {
            id: 'req-1',
            name: 'Create user (my edited one)',
            event: [{ listen: 'test', script: { exec: ['pm.test("201")'] } }],
            request: {
              method: 'POST',
              url: { raw: '{{baseUrl}}/users' },
              body: { mode: 'raw', raw: '{"name":"Real Person","email":"real@x.com"}' },
              header: [{ key: 'X-Custom', value: '1' }]
            }
          },
          // hardcoded host + /api prefix, and {{var}} path param
          { id: 'req-2', name: 'Get one', request: { method: 'GET', url: 'http://localhost:3000/api/users/{{userId}}' } }
        ]
      },
      { id: 'req-3', name: 'Old thing', request: { method: 'GET', url: { raw: '{{baseUrl}}/legacy' } } }
    ]
  };
}

const ENDPOINTS = [
  { method: 'POST', path: '/users', key: 'POST /users', tags: ['Users'], parameters: { body: { type: 'object', properties: { name: { type: 'string' } } } } },
  { method: 'GET', path: '/users/:id', key: 'GET /users/:id', tags: ['Users'] },
  { method: 'DELETE', path: '/users/:id', key: 'DELETE /users/:id', tags: ['Users'] },
  { method: 'GET', path: '/orders', key: 'GET /orders', tags: ['Orders'] }
];

test('additive: only new endpoints are added; existing requests are byte-for-byte unchanged', () => {
  const existing = userCollection();
  const before = JSON.parse(JSON.stringify(existing));
  const { collection, added, stale } = addNewEndpoints(existing, buildPostmanCollection(ENDPOINTS, CONFIG), CONFIG);

  assert.deepEqual(existing, before, 'input is not mutated');
  assert.deepEqual(added.map((a) => `${a.method} ${a.folder}`).sort(), ['DELETE Users', 'GET Orders']);

  // Every original request is still present and identical
  const byId = new Map(flatten(collection.item).map((i) => [i.id, i]));
  for (const original of flatten(before.item)) assert.deepEqual(byId.get(original.id), original);

  // Folder kept its own settings; new request went into it
  const users = collection.item.find((i) => i.name === 'Users');
  assert.deepEqual(users.auth, { type: 'bearer' });
  assert.equal(users.item.length, 3);

  // User variable values kept
  assert.equal(collection.variable.find((v) => v.key === 'authToken').value, 'secret');
  assert.equal(collection.variable.find((v) => v.key === 'baseUrl').value, 'https://staging.example.com/api');

  assert.deepEqual(stale.map((s) => s.name), ['Old thing']);
});

test('additive: running twice adds nothing the second time', () => {
  const generated = buildPostmanCollection(ENDPOINTS, CONFIG);
  const first = addNewEndpoints(userCollection(), generated, CONFIG);
  const second = addNewEndpoints(first.collection, generated, CONFIG);
  assert.equal(second.added.length, 0);
  assert.equal(second.addedVariables.length, 0);
});

test('additive: works with no existing collection', () => {
  const { collection, added } = addNewEndpoints(null, buildPostmanCollection(ENDPOINTS, CONFIG), CONFIG);
  assert.equal(added.length, 4);
  assert.equal(flatten(collection.item).length, 4);
});

// --- end to end: sync against a fake Postman API ---

function startFakePostman(initial) {
  const state = { collection: JSON.parse(JSON.stringify(initial)), puts: [], gets: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.headers['x-api-key'] !== 'test-key') {
        res.writeHead(401).end(JSON.stringify({ error: { name: 'AuthenticationError', message: 'bad key' } }));
        return;
      }
      if (req.url !== '/collections/col-123') {
        res.writeHead(404).end(JSON.stringify({ error: { name: 'instanceNotFoundError' } }));
        return;
      }
      if (req.method === 'GET') {
        state.gets += 1;
        res.writeHead(200).end(JSON.stringify({ collection: state.collection }));
      } else if (req.method === 'PUT') {
        const parsed = JSON.parse(body);
        state.puts.push(parsed);
        state.collection = parsed.collection;
        res.writeHead(200).end(JSON.stringify({ collection: { id: 'col-123' } }));
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state })));
}

async function makeProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'post-api-sync-e2e-'));
  await fs.outputFile(path.join(dir, 'src/routes/users.js'), `
    const router = require('express').Router();
    router.post('/users', (req, res) => res.end());
    router.get('/users/:id', (req, res) => res.end());
    router.delete('/users/:id', (req, res) => res.end());
    module.exports = router;`);
  await fs.outputJson(path.join(dir, 'post-api-sync.config.json'), {
    framework: 'express',
    sources: { include: ['src/routes/*.js'], baseUrl: 'http://localhost:3000/api' },
    output: { postman: { enabled: true, outputPath: './collections/postman.json' }, insomnia: { enabled: false } }
  });
  return dir;
}

test('sync: pushes only new requests to Postman and leaves existing ones untouched', async () => {
  const { server, state } = await startFakePostman(userCollection());
  process.env.POSTMAN_API_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  try {
    const dir = await makeProject();
    const opts = { configPath: dir, postmanKey: 'test-key', postmanId: 'col-123' };

    // dry run: reads only
    await syncOnce({ ...opts, dryRun: true });
    assert.equal(state.puts.length, 0);
    assert.ok(!(await fs.pathExists(path.join(dir, 'collections/postman.json'))));

    await syncOnce(opts);
    assert.equal(state.puts.length, 1);
    const sent = state.puts[0].collection;
    assert.equal(sent.info.updatedAt, undefined, 'read-only info fields are not sent back');
    const sentItems = flatten(sent.item);
    const added = sentItems.filter((i) => !i.id);
    assert.deepEqual(added.map((i) => i.request.method), ['DELETE']);
    for (const original of flatten(userCollection().item)) {
      assert.deepEqual(sentItems.find((i) => i.id === original.id), original);
    }

    // nothing new on the next run -> no PUT
    await syncOnce(opts);
    assert.equal(state.puts.length, 1);
  } finally {
    delete process.env.POSTMAN_API_BASE_URL;
    server.close();
  }
});

test('sync: a bad API key is reported and the collection is not modified', async () => {
  const { server, state } = await startFakePostman(userCollection());
  process.env.POSTMAN_API_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  const errors = [];
  const origError = console.error;
  console.error = (msg) => errors.push(String(msg));
  try {
    const dir = await makeProject();
    await syncOnce({ configPath: dir, postmanKey: 'wrong', postmanId: 'col-123' });
    assert.equal(state.puts.length, 0);
    assert.ok(errors.some((e) => /401/.test(e) && /POSTMAN_API_KEY/.test(e)), errors.join('\n'));
  } finally {
    console.error = origError;
    process.exitCode = 0;
    delete process.env.POSTMAN_API_BASE_URL;
    server.close();
  }
});

test('additive: hand-made requests with real IDs pasted in still match', () => {
  const existing = {
    info: { name: 'x' },
    item: [
      { name: 'get age demographic data', request: { method: 'GET', url: '{{admin}}/analytics/6650f1a2b3c4d5e6f7a8b9c0/demographic/age' } },
      { name: 'get agent', request: { method: 'GET', url: 'http://localhost:8000/api/agent/3fa85f64-5717-4562-b3fc-2c963f66afa6' } },
      { name: 'get order', request: { method: 'GET', url: '{{baseUrl}}/orders/42' } }
    ]
  };
  const endpoints = [
    { method: 'GET', path: '/analytics/:id/demographic/age', key: 'GET /analytics/:id/demographic/age', tags: ['A'] },
    { method: 'GET', path: '/agent/:agentId', key: 'GET /agent/:agentId', tags: ['A'] },
    { method: 'GET', path: '/agent/self', key: 'GET /agent/self', tags: ['A'] },
    { method: 'GET', path: '/orders/:id', key: 'GET /orders/:id', tags: ['A'] }
  ];
  const { added, stale } = addNewEndpoints(existing, buildPostmanCollection(endpoints, CONFIG), CONFIG);
  assert.deepEqual(added.map((a) => a.name), ['Get Self - GET /agent/self']);
  assert.deepEqual(stale, []);
});

test('sync: sources.includeRpc=false leaves out gRPC and event handlers', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'post-api-sync-rpc-'));
  await fs.outputFile(path.join(dir, 'src/users/users.controller.ts'), `
    import { Controller, Get } from '@nestjs/common';
    import { GrpcMethod, EventPattern } from '@nestjs/microservices';
    @Controller('users')
    export class UsersController {
      @Get() list() {}
      @GrpcMethod('UserService', 'FindOne') findOne() {}
      @EventPattern('user.created') onCreated() {}
    }`);
  await fs.outputJson(path.join(dir, 'post-api-sync.config.json'), {
    framework: 'nestjs',
    sources: { include: ['src/**/*.controller.ts'], includeRpc: false },
    output: { postman: { enabled: true, outputPath: './out.json' }, insomnia: { enabled: false } }
  });
  await syncOnce({ configPath: dir });
  const written = await fs.readJson(path.join(dir, 'out.json'));
  assert.deepEqual(flatten(written.item).map((i) => `${i.request.method} ${i.request.url.raw}`), ['GET {{baseUrl}}/users']);
});
