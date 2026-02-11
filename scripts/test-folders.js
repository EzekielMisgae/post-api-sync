const { buildPostmanCollection } = require('../src/collection/postman');
const path = require('path');

const endpoints = [
    {
        method: 'GET',
        path: '/users',
        filePath: path.resolve(process.cwd(), 'src/routes/users/list.ts'),
        description: 'Get Users'
    },
    {
        method: 'POST',
        path: '/auth/login',
        filePath: path.resolve(process.cwd(), 'src/routes/auth/login.ts'),
        description: 'Login'
    }
];

const config = {
    organization: { groupBy: 'folder' },
    output: { postman: { collectionName: 'Folder Test' } },
    sources: { baseUrl: 'http://localhost:3000' }
};

const collection = buildPostmanCollection(endpoints, config);
console.log(JSON.stringify(collection.item, null, 2));

// Check structure
function check(items) {
    const src = items.find(i => i.name === 'src');
    if (!src) throw new Error('Missing src folder');

    const routes = src.item.find(i => i.name === 'routes');
    if (!routes) throw new Error('Missing routes folder');

    const users = routes.item.find(i => i.name === 'users');
    if (!users) throw new Error('Missing users folder');

    // The item name should match description 'Get Users'
    const list = users.item.find(i => i.name === 'Get Users');
    if (!list) throw new Error('Missing Get Users request');

    console.log('Verification Passed!');
}

try {
    check(collection.item);
} catch (e) {
    console.error('Verification Failed:', e.message);
    process.exit(1);
}
