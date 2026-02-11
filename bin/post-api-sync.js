#!/usr/bin/env node

require('dotenv').config();
const { program } = require('commander');
const { initConfig } = require('../src/init');
const { syncOnce } = require('../src/sync');
const { watchMode } = require('../src/watch');

program
  .name('post-api-sync')
  .description('Sync Postman and Insomnia collections from API code')
  .action(async () => {
    // Default behavior: run sync
    await syncOnce();
  });

program
  .command('init')
  .description('Create post-api-sync.config.js')
  .option('--cwd <path>', 'Project root for config')
  .action(async (opts) => {
    await initConfig({ baseDir: opts.cwd });
  });

program
  .command('sync')
  .description('One-time collection sync')
  .option('-c, --config <path>', 'Path to config file OR project directory')
  .option('--cwd <path>', 'Project root (used for config + globs)')
  .option('--postman-key <key>', 'Postman API Key')
  .option('--postman-id <id>', 'Postman Collection UID')
  .action(async (opts) => {
    await syncOnce({
      configPath: opts.config,
      baseDir: opts.cwd,
      postmanKey: opts.postmanKey,
      postmanId: opts.postmanId
    });
  });

program
  .command('watch')
  .description('Watch for changes and sync collections')
  .option('-c, --config <path>', 'Path to config file OR project directory')
  .option('--cwd <path>', 'Project root (used for config + globs)')
  .option('--postman-key <key>', 'Postman API Key')
  .option('--postman-id <id>', 'Postman Collection UID')
  .action(async (opts) => {
    await watchMode({
      configPath: opts.config,
      baseDir: opts.cwd,
      postmanKey: opts.postmanKey,
      postmanId: opts.postmanId
    });
  });

program.parseAsync(process.argv);
