const fs = require('fs-extra');
const path = require('path');
const inquirer = require('inquirer');
const { DEFAULT_CONFIG, resolveConfigPath } = require('./config');
const { info, warn, success } = require('./log');

function getPrompt() {
  return inquirer.prompt || (inquirer.default && inquirer.default.prompt);
}

async function initConfig({ baseDir } = {}) {
  const prompt = getPrompt();
  if (!prompt) {
    throw new Error('Inquirer prompt not available. Please use Node 18+ and reinstall dependencies.');
  }

  const resolved = await resolveConfigPath(undefined, baseDir);
  const targetPath = resolved.path;
  if (await fs.pathExists(targetPath)) {
    warn(`Config already exists at ${targetPath}`);
    const { overwrite } = await prompt([
      {
        type: 'confirm',
        name: 'overwrite',
        message: 'Overwrite existing config?',
        default: false
      }
    ]);
    if (!overwrite) return;
  }

  const answers = await prompt([
    {
      type: 'list',
      name: 'framework',
      message: 'Which framework do you use?',
      choices: [
        { name: 'Auto-detect', value: 'auto' },
        { name: 'NestJS', value: 'nestjs' },
        { name: 'Express', value: 'express' },
        { name: 'Hono', value: 'hono' }
      ],
      default: 'auto'
    },
    {
      type: 'input',
      name: 'include',
      message: 'Glob(s) for route/controller files (comma-separated):',
      default: DEFAULT_CONFIG.sources.include.join(',')
    },
    {
      type: 'input',
      name: 'exclude',
      message: 'Glob(s) to exclude (comma-separated):',
      default: DEFAULT_CONFIG.sources.exclude.join(',')
    },
    {
      type: 'input',
      name: 'baseUrl',
      message: 'Base URL for collections:',
      default: DEFAULT_CONFIG.sources.baseUrl
    },
    {
      type: 'confirm',
      name: 'postmanEnabled',
      message: 'Generate Postman collection?',
      default: true
    },
    {
      type: 'input',
      name: 'postmanPath',
      message: 'Postman output path:',
      default: DEFAULT_CONFIG.output.postman.outputPath,
      when: (a) => a.postmanEnabled
    },
    {
      type: 'confirm',
      name: 'insomniaEnabled',
      message: 'Generate Insomnia collection?',
      default: true
    },
    {
      type: 'input',
      name: 'insomniaPath',
      message: 'Insomnia output path:',
      default: DEFAULT_CONFIG.output.insomnia.outputPath,
      when: (a) => a.insomniaEnabled
    }
  ]);

  const config = {
    framework: answers.framework,
    sources: {
      include: answers.include.split(',').map((s) => s.trim()).filter(Boolean),
      exclude: answers.exclude.split(',').map((s) => s.trim()).filter(Boolean),
      baseUrl: answers.baseUrl
    },
    output: {
      postman: {
        enabled: !!answers.postmanEnabled,
        outputPath: answers.postmanPath
      },
      insomnia: {
        enabled: !!answers.insomniaEnabled,
        outputPath: answers.insomniaPath
      }
    },
    watch: {
      enabled: true,
      debounce: DEFAULT_CONFIG.watch.debounce
    },
    merge: {
      markDeprecated: true
    },
    organization: {
      groupBy: 'tags'
    }
  };

  const contents = `module.exports = ${JSON.stringify(config, null, 2)};\n`;
  await fs.outputFile(targetPath, contents);
  info(`Saved config to ${targetPath}`);
  success('Done');
}

module.exports = { initConfig };
