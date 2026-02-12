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
    baseUrl: 'http://localhost:3000/api'
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

### Environment Variables
You can use a `.env` file in your project root to store sensitive keys:
```bash
POSTMAN_API_KEY=your-api-key
POSTMAN_COLLECTION_ID=your-collection-uid
```

## Postman Cloud Sync

You can push your generated collection directly to Postman without manual importing.

1.  Get your **Postman API Key** from your [Account Settings](https://postman.co/settings/me/api-keys).
2.  Get your **Collection UID** (Right-click collection -> Info).
3.  Run the sync command:

```bash
# Finds keys in .env or config
npx post-api-sync

# Or specify manually
npx post-api-sync sync --postman-key <YOUR_KEY> --postman-id <COLLECTION_UID>
```

Or set them in your config/environment variables to use with `watch` mode.

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

## License

MIT
