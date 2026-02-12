const { nanoid } = require('nanoid');
const path = require('path');
const { normalizePath, toPostmanPath, splitPath, extractPathParams } = require('../utils');

const DEFAULT_COLLECTION_NAME = 'API Collection';
const UUID_SAMPLE = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

function buildPostmanCollection(endpoints, config) {
  const name = (config.output && config.output.postman && config.output.postman.collectionName) || DEFAULT_COLLECTION_NAME;
  const baseUrl = (config.sources && config.sources.baseUrl) || 'http://localhost:3000/api';
  const groupBy = (config.organization && config.organization.groupBy) || 'folder';

  const items = groupBy === 'folder'
    ? buildFolderItems(endpoints)
    : buildTaggedItems(endpoints);

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
  const folders = new Map();

  for (const endpoint of endpoints) {
    const folderName = deriveFolderName(endpoint);
    if (!folders.has(folderName)) {
      folders.set(folderName, { name: folderName, item: [] });
    }
    folders.get(folderName).item.push(buildItem(endpoint));
  }

  return Array.from(folders.values());
}

function buildTaggedItems(endpoints) {
  const groups = new Map();
  for (const endpoint of endpoints) {
    const tags = endpoint.tags && endpoint.tags.length ? endpoint.tags : ['General'];
    const tag = cleanLabel(tags[0] || 'General');
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
  const originalPath = normalizePath(endpoint.path || '/');
  const postmanPath = toPostmanPath(originalPath);
  const displayPath = toDisplayPath(originalPath);

  const queryParams = buildQueryParams((endpoint.parameters && endpoint.parameters.query) || []);
  const pathVariables = buildPathVariables(postmanPath, endpoint);
  const bodySchema = endpoint.parameters && endpoint.parameters.body ? endpoint.parameters.body : null;
  const hasBody = !!bodySchema;

  const headers = [];
  if (hasBody) {
    headers.push({ key: 'Content-Type', value: 'application/json', type: 'text' });
  }

  if (needsAuthorization(endpoint, postmanPath)) {
    headers.push({ key: 'Authorization', value: 'Bearer {{authToken}}', type: 'text' });
  }

  const rawUrl = buildRawUrl(postmanPath, queryParams);
  const url = {
    raw: rawUrl,
    host: ['{{baseUrl}}'],
    path: splitPath(postmanPath)
  };

  if (queryParams.length) {
    url.query = queryParams;
  }

  if (pathVariables.length) {
    url.variable = pathVariables;
  }

  const method = String(endpoint.method || 'GET').toUpperCase();
  const summary = resolveSummary(endpoint);
  const description = buildRequestDescription(endpoint, summary);

  const request = {
    method,
    header: headers,
    url,
    description
  };

  if (hasBody) {
    request.body = {
      mode: 'raw',
      raw: JSON.stringify(exampleFromSchema(bodySchema), null, 2)
    };
  }

  return {
    name: `${summary} - ${method} ${displayPath}`,
    request
  };
}

function deriveFolderName(endpoint) {
  if (endpoint.filePath) {
    const parts = endpoint.filePath.split(path.sep).filter(Boolean);
    const filename = parts[parts.length - 1] || '';
    const parent = parts[parts.length - 2] || '';
    const grandparent = parts[parts.length - 3] || '';
    const base = filename.replace(/\.(t|j)sx?$/i, '');

    if (base === 'routes') return cleanLabel(parent || grandparent || 'General');

    if (base.endsWith('.routes')) {
      if (parent === 'routes' && grandparent) return cleanLabel(grandparent);
      const routeStem = base.replace(/\.routes$/i, '');
      if (routeStem && routeStem !== 'index') return cleanLabel(routeStem);
      return cleanLabel(parent || grandparent || 'General');
    }

    if (parent === 'routes') {
      return cleanLabel(base || grandparent || 'General');
    }

    if (parent) {
      if (parent === 'routes' && grandparent) return cleanLabel(grandparent);
      return cleanLabel(parent);
    }
  }

  if (endpoint.tags && endpoint.tags.length) {
    return cleanLabel(endpoint.tags[0]);
  }

  return cleanLabel(inferDomainFromPath(endpoint.path || '/'));
}

function inferDomainFromPath(routePath) {
  const segments = normalizePath(routePath)
    .split('/')
    .filter(Boolean)
    .filter((s) => s.toLowerCase() !== 'api');

  for (const segment of segments) {
    if (isPathParamSegment(segment)) continue;
    return segment;
  }

  return 'General';
}

function cleanLabel(label) {
  const value = String(label || '')
    .replace(/\.(t|j)sx?$/i, '')
    .replace(/\.routes$/i, '')
    .replace(/^routes$/i, '')
    .replace(/[_\-.]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();

  if (!value) return 'General';

  return value
    .split(/\s+/)
    .map((word) => {
      if (word.toUpperCase() === 'API') return 'API';
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

function toDisplayPath(routePath) {
  return normalizePath(routePath || '/')
    .replace(/:([A-Za-z0-9_]+)/g, '{$1}')
    .replace(/{{([A-Za-z0-9_]+)}}/g, '{$1}');
}

function resolveSummary(endpoint) {
  if (endpoint.summary && String(endpoint.summary).trim()) {
    return String(endpoint.summary).trim();
  }

  const description = String(endpoint.description || '').trim();
  if (description && !isAutoDescription(description, endpoint.method, endpoint.path)) {
    const cleaned = stripMethodPrefix(description, endpoint.method);
    if (cleaned) return cleaned;
  }

  return fallbackSummary(endpoint.method, endpoint.path);
}

function stripMethodPrefix(text, method) {
  const value = String(text || '').trim();
  if (!value) return '';
  const methodName = String(method || '').toUpperCase();

  const withDash = new RegExp(`^${methodName}\\s+[^-]+-\\s*`, 'i');
  if (withDash.test(value)) return value.replace(withDash, '').trim();

  const direct = new RegExp(`^${methodName}\\s+`, 'i');
  if (direct.test(value)) return value.replace(direct, '').trim();

  return value;
}

function fallbackSummary(method, routePath) {
  const methodName = String(method || 'GET').toUpperCase();
  const segments = normalizePath(routePath || '/').split('/').filter(Boolean);
  const cleanSegments = segments.filter((s) => !isPathParamSegment(s)).map((s) => cleanLabel(s));
  const resource = cleanSegments.length ? cleanSegments[cleanSegments.length - 1] : 'Root';

  const action = {
    GET: 'Get',
    POST: 'Create',
    PUT: 'Replace',
    PATCH: 'Update',
    DELETE: 'Delete',
    HEAD: 'Head',
    OPTIONS: 'Options'
  }[methodName] || 'Call';

  if (resource === 'Root') return action;
  return `${action} ${resource}`;
}

function isAutoDescription(description, method, routePath) {
  const text = String(description || '').trim();
  if (!text) return true;

  const methodName = String(method || '').toUpperCase();
  const pathVariants = new Set([
    normalizePath(routePath || '/'),
    toDisplayPath(routePath || '/'),
    toPostmanPath(routePath || '/')
  ]);

  for (const route of pathVariants) {
    if (text.toLowerCase() === `${methodName} ${route}`.toLowerCase()) return true;
  }

  return false;
}

function buildRequestDescription(endpoint, summary) {
  const description = String(endpoint.description || '').trim();
  const hasExplicitSummary = !!(endpoint.summary && String(endpoint.summary).trim());
  if (!description || isAutoDescription(description, endpoint.method, endpoint.path)) {
    return hasExplicitSummary ? summary : '';
  }

  if (hasExplicitSummary && summary && summary.toLowerCase() !== description.toLowerCase()) {
    return `${summary}\n\n${description}`;
  }
  return description;
}

function needsAuthorization(endpoint, postmanPath) {
  if (endpoint.auth) return true;

  const middlewareNames = []
    .concat(endpoint.middleware || [])
    .concat(endpoint.guards || [])
    .concat(endpoint.decorators || [])
    .join(' ')
    .toLowerCase();

  if (/(auth|guard|protect|require|role|permission|bearer|jwt)/.test(middlewareNames)) {
    return true;
  }

  const segments = normalizePath(postmanPath || '/')
    .toLowerCase()
    .split('/')
    .filter(Boolean)
    .filter((segment) => !isPathParamSegment(segment));

  const requiresAuthSegment = new Set(['admin', 'me', 'ping', 'export', 'wholesale', 'my', 'all']);
  return segments.some((segment) => requiresAuthSegment.has(segment));
}

function buildQueryParams(queryParams) {
  return (queryParams || []).map((q) => {
    const key = q.key || q.name;
    const type = normalizeType(q.type);
    const required = q.required === true;
    const inferred = inferPrimitiveExample(key, type, 'query');
    const useProvidedExample = q.example !== undefined &&
      q.example !== '' &&
      !preferInferredQueryExample(key, q.example);

    const rawExample = q.value !== undefined
      ? q.value
      : useProvidedExample
        ? q.example
        : inferred;

    const value = toQueryStringValue(rawExample);
    const item = { key, value };

    if (q.disabled !== undefined) {
      item.disabled = !!q.disabled;
    } else if (!required && shouldDisableOptionalQuery(key)) {
      item.disabled = true;
    }

    return item;
  });
}

function preferInferredQueryExample(key, example) {
  const normalizedKey = String(key || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  if (['userid', 'orderid', 'wholesalecustomerid', 'limit', 'offset', 'status'].includes(normalizedKey)) {
    return true;
  }
  if (example === '' || example === null || example === undefined) return true;
  return false;
}

function shouldDisableOptionalQuery(key) {
  const value = String(key || '').toLowerCase();
  if (!value) return false;
  if (['limit', 'offset', 'page', 'size', 'perpage', 'userid'].includes(value)) return false;
  return ['status', 'search', 'sort', 'filter', 'from', 'to', 'q'].includes(value);
}

function buildPathVariables(postmanPath, endpoint) {
  const params = new Map();
  for (const name of extractPathParams(postmanPath)) {
    params.set(name, { name, type: 'string', required: true });
  }

  const explicit = []
    .concat((endpoint.parameters && endpoint.parameters.path) || [])
    .concat((endpoint.parameters && endpoint.parameters.params) || []);

  for (const param of explicit) {
    const key = param && (param.key || param.name);
    if (!key) continue;
    params.set(key, {
      name: key,
      type: normalizeType(param.type),
      required: param.required !== false,
      example: param.example
    });
  }

  return Array.from(params.values()).map((param) => {
    const inferred = param.example !== undefined
      ? param.example
      : inferPrimitiveExample(param.name, param.type || 'string', 'path');
    return {
      key: param.name,
      value: typeof inferred === 'string' ? inferred : String(inferred)
    };
  });
}

function buildRawUrl(postmanPath, queryParams) {
  let raw = `{{baseUrl}}${postmanPath}`;
  const queryString = (queryParams || [])
    .filter((q) => !q.disabled)
    .map((q) => `${q.key}=${q.value || ''}`)
    .join('&');

  if (queryString) raw += `?${queryString}`;
  return raw;
}

function exampleFromSchema(schema, depth = 0, keyPath = []) {
  if (!schema || depth > 6) {
    return inferPrimitiveExample(keyPath[keyPath.length - 1], 'string', 'body');
  }

  if (schema.example !== undefined) return clone(schema.example);
  if (Array.isArray(schema.enum) && schema.enum.length) return clone(schema.enum[0]);

  const type = normalizeType(schema.type || (schema.properties ? 'object' : schema.items ? 'array' : 'string'));

  if (type === 'object') {
    const properties = schema.properties || {};
    const requiredSet = new Set(schema.required || []);
    const keys = Object.keys(properties).sort((a, b) => {
      const aReq = requiredSet.has(a) ? 0 : 1;
      const bReq = requiredSet.has(b) ? 0 : 1;
      if (aReq !== bReq) return aReq - bReq;
      return a.localeCompare(b);
    });

    const out = {};
    for (const key of keys) {
      out[key] = exampleFromSchema(properties[key], depth + 1, [...keyPath, key]);
    }
    return out;
  }

  if (type === 'array') {
    const itemSchema = schema.items || { type: 'string' };
    return [exampleFromSchema(itemSchema, depth + 1, [...keyPath, 'item'])];
  }

  return inferPrimitiveExample(keyPath[keyPath.length - 1], type, 'body');
}

function inferPrimitiveExample(name, type, context) {
  const key = String(name || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  const normalizedType = normalizeType(type);

  const variableMap = {
    userid: '{{userId}}',
    orderid: '{{orderId}}',
    wholesalecustomerid: '{{wholesaleCustomerId}}',
    authtoken: '{{authToken}}'
  };

  if (variableMap[key]) return variableMap[key];

  if (normalizedType === 'number' || normalizedType === 'integer') {
    if (key.includes('limit')) return 20;
    if (key.includes('offset')) return 0;
    if (key.includes('page')) return 1;
    if (key.includes('quantity')) return 2;
    if (key.includes('count')) return 1;
    if (key.includes('amount') || key.includes('total') || key.includes('price')) return 100;
    return 1;
  }

  if (normalizedType === 'boolean') {
    return false;
  }

  if (context === 'query') {
    if (key.includes('limit')) return '20';
    if (key.includes('offset')) return '0';
    if (key.includes('status')) return 'pending';
  }

  if (key.includes('pushtoken')) return 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]';
  if (key === 'title') return 'Test Notification';
  if (key === 'body' || key.includes('message')) return 'This is a test notification message';
  if (key === 'type') return 'test';
  if (key === 'action') return 'open';
  if (key.includes('status')) return 'pending';
  if (key.includes('address')) return '123 Main St, Addis Ababa, Ethiopia';
  if (key.includes('phone')) return '+251911223344';
  if (key.includes('zoneid') || key.includes('productid') || key.includes('batchid')) return UUID_SAMPLE;
  if (key.endsWith('id') || key.includes('uuid')) return UUID_SAMPLE;
  if (key.includes('email')) return 'user@example.com';
  if (key.includes('name')) return 'Sample Name';
  if (key.includes('notes')) return 'Please deliver in the morning';
  if (key.includes('method')) return 'card';
  if (key.includes('token')) return 'token_example';

  return 'string';
}

function toQueryStringValue(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function normalizeType(type) {
  const value = String(type || 'string').toLowerCase();
  if (value === 'int' || value === 'float' || value === 'double') return 'number';
  return value;
}

function isPathParamSegment(segment) {
  return /^:/.test(segment) || /^{.+}$/.test(segment) || /^{{.+}}$/.test(segment);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = { buildPostmanCollection };
