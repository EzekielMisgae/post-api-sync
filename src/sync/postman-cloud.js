// Postman API client (works with a free-plan API key).
// POSTMAN_API_BASE_URL is only meant for tests.
const DEFAULT_API_BASE = 'https://api.getpostman.com';

function apiBase() {
  return (process.env.POSTMAN_API_BASE_URL || DEFAULT_API_BASE).replace(/\/+$/, '');
}

async function postmanRequest(method, urlPath, apiKey, body) {
  const res = await fetch(`${apiBase()}${urlPath}`, {
    method,
    headers: {
      'X-Api-Key': apiKey,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // keep the raw text for the error message
  }

  if (!res.ok) {
    const detail = json && json.error ? `${json.error.name || ''} ${json.error.message || ''}`.trim() : text;
    let hint = '';
    if (res.status === 401) hint = ' (check POSTMAN_API_KEY)';
    if (res.status === 404) hint = ' (check POSTMAN_COLLECTION_ID; use the collection ID/UID from the collection\'s Info panel)';
    if (res.status === 429) hint = ' (Postman API rate/usage limit reached)';
    throw new Error(`Postman API ${method} ${urlPath} failed: ${res.status} ${detail}${hint}`);
  }
  return json;
}

async function fetchCollection(apiKey, collectionId) {
  const data = await postmanRequest('GET', `/collections/${encodeURIComponent(collectionId)}`, apiKey);
  if (!data || !data.collection) throw new Error('Postman API returned no collection');
  return data.collection;
}

// The GET response's info block carries read-only fields (createdAt, updatedAt, uid, ...);
// send back only the writable ones. Item ids are kept so Postman updates in place.
function toWritableCollection(collection) {
  const info = collection.info || {};
  const writableInfo = { name: info.name, schema: info.schema };
  if (info._postman_id) writableInfo._postman_id = info._postman_id;
  if (info.description !== undefined) writableInfo.description = info.description;
  return { ...collection, info: writableInfo };
}

async function updateCollection(apiKey, collectionId, collection) {
  return postmanRequest(
    'PUT',
    `/collections/${encodeURIComponent(collectionId)}`,
    apiKey,
    { collection: toWritableCollection(collection) }
  );
}

module.exports = { fetchCollection, updateCollection, toWritableCollection };
