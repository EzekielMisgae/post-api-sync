# Examples

These are minimal code samples to validate extraction.

## NestJS Basic
- `examples/nestjs-basic/src/users/users.controller.ts`
- `examples/nestjs-basic/src/users/create-user.dto.ts`

## Express Basic
- `examples/express-basic/src/app.js`
- `examples/express-basic/src/routes/users.js`

To test locally:

```bash
cd /Users/kaleab/Documents/ET/livepost
node bin/post-api-sync.js sync --config post-api-sync.config.js
```

Update `post-api-sync.config.js` include paths to point at `examples/**` as needed.
