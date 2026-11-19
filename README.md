# post-api-sync

Sync your API code directly to Postman and Insomnia collections. 

`post-api-sync` extracts endpoint definitions, parameters, and validation schemas (Zod, Class Validator) from your Hono, Express, or NestJS code and generates ready-to-use collections. It can also push changes directly to Postman Cloud.

## Features

- 🔍 **Auto-Extraction**: Scans your codebase for API routes and definitions.
- 🛠 **Framework Support**: 
  - **Hono**: Extract routes and `zValidator` schemas.
  - **Express**: Extract routes and validation middleware.
  - **NestJS**: Extract Controllers, DTOs, and `class-validator` decorators.
- 📦 **Rich Collections**: Generates Postman and Insomnia collections with request bodies, query parameters, and examples.
- ☁️ **Live Sync**: Push collections directly to the Postman Cloud API.
- 👀 **Watch Mode**: Automatically sync changes as you code.

## Installation

```bash
npm install -g post-api-sync
# or use via npx
npx post-api-sync --help
```

## Quick Start

1.  **Initialize configuration**:
    ```bash
    npx post-api-sync init
    ```
    This will create an `post-api-sync.config.js` file in your project root.
    The init flow auto-detects framework (NestJS/Express/Hono), supports multi-app base URLs (e.g. ports 3000-3003), and uses monorepo-ready include patterns (`src`, `apps/*/src`, `services/*/src`, `libs/*/src`) by default.

2.  **Run extraction**:
    ```bash
    npx post-api-sync sync
    ```

3.  **Watch for changes**:
    ```bash
    npx post-api-sync watch
    ```

## Configuration

The `post-api-sync.config.js` file allows you to customize the tool's behavior:

```javascript
module.exports = {
  // 'hono', 'express', 'nestjs', or 'auto'
  framework: 'auto',

  sources: {
    // Glob patterns to include
    include: ['src/**/*.ts', 'src/**/*.js'],
    // Glob patterns to exclude
    exclude: ['**/*.test.ts'],
    // Base URL for variables in collections
    baseUrl: 'http://localhost:3000/api',
    // Optional: multi-app base URLs (microservices/monorepo)
    // appBaseUrls: {
    //   auth: 'http://localhost:8000/api',
    //   orders: 'http://localhost:8001/api',
    //   inventory: 'http://localhost:8002/api',
    //   payments: 'http://localhost:8003/api'
    // }
  },

  organization: {
    // 'folder' (default) or 'tags'
    groupBy: 'folder'
  },

  output: {
    postman: {
      enabled: true,
      outputPath: './postman_collection.json',
      // Optional: Default API Key and Collection ID for Cloud Sync
      apiKey: process.env.POSTMAN_API_KEY,
      collectionId: process.env.POSTMAN_COLLECTION_ID
    },
    // ...
  }
};
```

When `sources.appBaseUrls` is set, generated requests automatically use app-specific variables like `{{baseUrl_orders}}` based on endpoint file paths (for example `apps/orders/...`).
For monorepos, folder organization is app-aware by default: requests are grouped as `App -> Module -> (Submodule)` based on file paths (for example `apps/business/src/review/review.controller.ts` -> `Business / Review`).
If configured include globs match no files, sync now auto-discovers route/controller candidates across the repository (while ignoring build/dependency folders), so unusual project layouts still work without manual glob updates.

### Environment Variables
You can use a `.env` file in your project root to store sensitive keys:
```bash
POSTMAN_API_KEY=your-api-key
POSTMAN_COLLECTION_ID=your-collection-uid
```

## Postman Cloud Sync

Sync adds new endpoints to your existing Postman collection and leaves everything already in it alone. Requests you've edited keep their bodies, headers, scripts, examples, names and folders. Collection variables keep their values; only missing ones get added.

1.  Create a **Postman API Key** in [Settings → API keys](https://postman.co/settings/me/api-keys). The free plan works.
2.  Copy your **Collection ID**: open the collection in Postman → **Info** panel (the `i` icon on the right).
3.  Put both in a `.env` file in the project root:

```bash
POSTMAN_API_KEY=PMAK-xxxxxxxx
POSTMAN_COLLECTION_ID=12345678-aaaa-bbbb-cccc-1234567890ab
```

4.  Preview first, then sync:

```bash
npx post-api-sync sync --dry-run   # lists what would be added; changes nothing
npx post-api-sync sync             # adds the new requests to Postman
```

How it works:
- It fetches the collection, finds endpoints in your code that aren't in it yet, and puts each one in a matching folder (the folder is created if it's missing).
- A request counts as already present if its method and path match. Matching ignores the host (`{{baseUrl}}`, `{{anything}}` or `http://localhost:3000`), ignores the base URL's path prefix such as `/api`, and ignores how path params are written (`:id`, `{id}` or `{{userId}}`).
- If nothing is new, nothing is sent. Otherwise it makes one GET and one PUT. Free Postman plans have a monthly API call limit, so be careful with `watch` mode.
- Requests that no longer match anything in code are listed as warnings and are never renamed or deleted.

The local file at `output.postman.outputPath` is updated the same way. To go back to the old behaviour, where existing requests are overwritten from code, set `merge: { updateExisting: true }`. That only affects the local file.

## Supported Patterns

### Hono
- `zValidator('json', schema)` -> Request Body
- `zValidator('query', schema)` -> Query Parameters

### Express
- Router methods: `router.get`, `router.post`, etc.
- Validation middleware extraction (mapped to Zod schemas).

### NestJS
- `@Controller`, `@Get`, `@Post`, etc.
- DTOs in `@Body()` and `@Query()`.
- `class-validator` decorators: `@IsString`, `@IsInt`, `@Min`, etc.
- `@ApiProperty({ example: ... })` for example values.
- gRPC/microservice handlers: `@GrpcMethod`, `@GrpcStreamMethod`, `@MessagePattern`, `@EventPattern`.

## License

MIT
