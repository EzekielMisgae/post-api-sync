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

  // IMPORTANT: variable comes BEFORE item in the collection structure
  return {
    info: {
      _postman_id: nanoid(),
      name,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
    },
    variable: [
      { key: 'baseUrl', value: baseUrl, type: 'string' },
      { key: 'authToken', value: '', type: 'string' },
      { key: 'userId', value: '', type: 'string' },
      { key: 'orderId', value: '', type: 'string' },
      { key: 'wholesaleCustomerId', value: '', type: 'string' }
    ],
    item: items
  };
}

function buildFolderItems(endpoints) {
  const root = { item: [], _folders: {} };

  for (const endpoint of endpoints) {
    // Determine module name from file path
    // e.g. /abs/path/to/src/modules/health/routes.ts -> Health
    // e.g. /abs/path/to/src/modules/orders/routes/order.routes.ts -> Orders
    let moduleName = 'General';
    if (endpoint.filePath) {
      const parts = endpoint.filePath.split(path.sep);
      const filename = parts[parts.length - 1];
      const parent = parts[parts.length - 2];
      const grandparent = parts[parts.length - 3];

      if (filename === 'routes.ts' || filename.endsWith('.routes.ts')) {
        if (parent === 'routes' && grandparent) {
          moduleName = capitalize(grandparent);
        } else {
          moduleName = capitalize(parent);
        }
      } else {
        // Fallback: try to find a meaningful parent
        // If parent is 'routes', go up one
        if (parent === 'routes' && grandparent) {
          moduleName = capitalize(grandparent);
        } else {
          moduleName = capitalize(parent);
        }
      }
    }

    if (!root._folders[moduleName]) {
      const folder = {
        name: moduleName,
        description: `All endpoints from ${endpoint.filePath || 'this module'}`,
        item: [],
        _folders: {}
      };
      root.item.push(folder);
      root._folders[moduleName] = folder;
    }

    root._folders[moduleName].item.push(buildItem(endpoint));
  }

  return cleanFolders(root.item);
}

function capitalize(str) {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
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

  // Build headers
  const headers = [];
  if (hasBody) {
    headers.push({ key: 'Content-Type', value: 'application/json', type: 'text' });
  }

  // Detect auth requirement from middleware or path patterns
  const authMiddleware = endpoint.middleware && endpoint.middleware.some(m =>
    m.includes('require') || m.includes('auth') || m.includes('Auth') || m.includes('protect')
  );
  const authPath = path.includes('/admin') || path.includes('/me') || path.includes('/user') ||
    path.includes('/ping') || path.includes('/export') || path.includes('/wholesale') ||
    path.includes('/my') || path.includes('/all');
  const needsAuth = authMiddleware || authPath || endpoint.auth;

  if (needsAuth) {
    headers.push({ key: 'Authorization', value: 'Bearer {{authToken}}', type: 'text' });
  }

  // Build query string for raw URL
  let rawUrl = `{{baseUrl}}${path}`;
  const queryString = queryParams
    .filter(q => !q.disabled)
    .map(q => {
      const value = q.value || q.example || (q.type === 'number' ? '20' : q.required ? `{{${q.name}}}` : '');
      return `${q.key || q.name}=${value}`;
    })
    .filter(Boolean)
    .join('&');
  if (queryString) rawUrl += '?' + queryString;

  const url = {
    raw: rawUrl,
    host: ['{{baseUrl}}'],
    path: splitPath(path)
  };

  // Only include query/variable arrays if they have content
  if (queryParams.length > 0) {
    url.query = queryParams.map((q) => {
      const item = {
        key: q.key || q.name,
        value: q.value || q.example || ''
      };
      if (q.disabled) item.disabled = true;
      return item;
    });
  }

  if (pathParams.length > 0) {
    url.variable = pathParams.map((p) => ({ key: p, value: '' }));
  }

  const request = {
    method: endpoint.method,
    header: headers,
    url,
    description: endpoint.description || `${endpoint.method} ${endpoint.path}`
  };

  if (hasBody) {
    request.body = {
      mode: 'raw',
      raw: JSON.stringify(example || {}, null, 2)
    };
  }

  // Use format: "{summary} - {method} {path}"
  const requestName = endpoint.summary
    ? `${endpoint.summary} - ${endpoint.method} ${endpoint.path}`
    : endpoint.description || `${endpoint.method} ${endpoint.path}`;

  return {
    name: requestName,
    request
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
