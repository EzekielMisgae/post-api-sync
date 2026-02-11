const { nanoid } = require('nanoid');
const path = require('path');
const { toPostmanPath, splitPath, extractPathParams } = require('../utils');

function buildPostmanCollection(endpoints, config) {
  const name = (config.output && config.output.postman && config.output.postman.collectionName) || 'API Collection';
  const baseUrl = (config.sources && config.sources.baseUrl) || 'http://localhost:3000';
  const groupBy = (config.organization && config.organization.groupBy) || 'folder';

  let items;
  if (groupBy === 'folder') {
    items = buildFolderItems(endpoints);
  } else {
    items = buildTaggedItems(endpoints);
  }

  return {
    info: {
      name,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      _postman_id: nanoid()
    },
    item: items,
    variable: [{ key: 'baseUrl', value: baseUrl }]
  };
}

function buildFolderItems(endpoints) {
  const root = { item: [], _folders: {} };
  const cwd = process.cwd();

  for (const endpoint of endpoints) {
    const relPath = endpoint.filePath ? path.relative(cwd, endpoint.filePath) : '';
    const dir = path.dirname(relPath);
    // Split dir into parts, ignoring '.' or empty
    const parts = dir.split(path.sep).filter(p => p && p !== '.');

    let current = root;
    for (const part of parts) {
      // Skip common source dirs if desired, but user asked for folder structure
      if (!current._folders[part]) {
        const folder = { name: part, item: [], _folders: {} };
        current.item.push(folder);
        current._folders[part] = folder;
      }
      current = current._folders[part];
    }
    current.item.push(buildItem(endpoint));
  }

  return cleanFolders(root.item);
}

function cleanFolders(items) {
  // Remove temporary _folders property
  for (const item of items) {
    if (item._folders) delete item._folders;
    if (item.item) cleanFolders(item.item);
  }
  return items;
}

function buildTaggedItems(endpoints) {
  const groups = new Map();
  for (const endpoint of endpoints) {
    const tags = endpoint.tags && endpoint.tags.length ? endpoint.tags : ['General'];
    const tag = tags[0];
    if (!groups.has(tag)) groups.set(tag, []);
    groups.get(tag).push(buildItem(endpoint));
  }
  const items = [];
  for (const [name, groupItems] of groups.entries()) {
    items.push({ name, item: groupItems });
  }
  return items;
}

function buildItem(endpoint) {
  const path = toPostmanPath(endpoint.path);
  const pathParams = extractPathParams(path);
  const queryParams = (endpoint.parameters && endpoint.parameters.query) || [];
  const bodySchema = endpoint.parameters && endpoint.parameters.body ? endpoint.parameters.body : null;
  const hasBody = !!bodySchema;

  const example = hasBody ? exampleFromSchema(bodySchema) : null;

  return {
    name: endpoint.description || `${endpoint.method} ${endpoint.path}`,
    request: {
      method: endpoint.method,
      header: hasBody ? [{ key: 'Content-Type', value: 'application/json' }] : [],
      url: {
        raw: `{{baseUrl}}${path}`,
        host: ['{{baseUrl}}'],
        path: splitPath(path),
        query: queryParams.map((q) => ({ key: q.name, value: '', disabled: !q.required })),
        variable: pathParams.map((p) => ({ key: p, value: '' }))
      },
      body: hasBody
        ? {
          mode: 'raw',
          raw: JSON.stringify(example || {}, null, 2),
          options: { raw: { language: 'json' } }
        }
        : undefined
    },
    response: []
  };
}

function exampleFromSchema(schema, depth = 0) {
  if (!schema || depth > 3) return {};
  if (schema.example !== undefined) return schema.example;
  if (schema.type === 'string') return '';
  if (schema.type === 'number') return 0;
  if (schema.type === 'boolean') return false;
  if (schema.type === 'array') return [exampleFromSchema(schema.items || {}, depth + 1)];
  if (schema.type === 'object') {
    const obj = {};
    const props = schema.properties || {};
    for (const key of Object.keys(props)) {
      obj[key] = exampleFromSchema(props[key], depth + 1);
    }
    return obj;
  }
  return {};
}

module.exports = { buildPostmanCollection };
