const fs = require('fs-extra');
const path = require('path');
const inquirer = require('inquirer');
const fg = require('fast-glob');
const { DEFAULT_CONFIG, resolveConfigPath } = require('./config');
const { info, warn, success } = require('./log');

const FRAMEWORK_PRESETS = {
  auto: ['src/**/routes.ts', 'src/**/*.routes.ts', 'src/**/*.controller.ts'],
  nestjs: ['src/**/*.controller.ts', 'src/**/routes.ts', 'src/**/*.routes.ts'],
  express: ['src/**/routes.{js,ts}', 'src/**/*.routes.{js,ts}', 'src/**/*router.{js,ts}'],
  hono: ['src/**/routes.ts', 'src/**/*.routes.ts', 'src/**/*.route.ts']
};

function getPrompt() {
  return inquirer.prompt || (inquirer.default && inquirer.default.prompt);
}

function parseCsv(input) {
  return String(input || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function prettyFramework(framework) {
  if (framework === 'nestjs') return 'NestJS';
  if (framework === 'express') return 'Express';
  if (framework === 'hono') return 'Hono';
  return 'Auto-detect';
}

function getIncludePreset(framework) {
  return FRAMEWORK_PRESETS[framework] || FRAMEWORK_PRESETS.auto;
}

async function readPackageJson(projectDir) {
  const pkgPath = path.join(projectDir, 'package.json');
  if (!await fs.pathExists(pkgPath)) return null;
  try {
    return await fs.readJson(pkgPath);
  } catch {
    return null;
  }
}

function hasAnyDependency(pkg, names) {
  const all = {
    ...(pkg && pkg.dependencies ? pkg.dependencies : {}),
    ...(pkg && pkg.devDependencies ? pkg.devDependencies : {}),
    ...(pkg && pkg.peerDependencies ? pkg.peerDependencies : {})
  };
  return names.some((name) => !!all[name]);
}

async function detectFramework(projectDir) {
  const scores = { nestjs: 0, express: 0, hono: 0 };
  let grpcDetected = false;

  const pkg = await readPackageJson(projectDir);
  if (pkg) {
    if (hasAnyDependency(pkg, ['@nestjs/common', '@nestjs/core', '@nestjs/microservices'])) {
      scores.nestjs += 6;
    }
    if (hasAnyDependency(pkg, ['hono', '@hono/node-server', '@hono/zod-openapi'])) {
      scores.hono += 6;
    }
    if (hasAnyDependency(pkg, ['express'])) {
      scores.express += 6;
    }
    if (hasAnyDependency(pkg, ['@grpc/grpc-js', '@grpc/proto-loader'])) {
      scores.nestjs += 2;
      grpcDetected = true;
    }
  }

  const files = await fg(
    [
      'src/**/*.controller.ts',
      'src/**/*.routes.ts',
      'src/**/routes.ts',
      'src/**/*router.{js,ts}',
      'src/**/*hono*.{js,ts}',
      'src/**/*grpc*.controller.ts',
      '**/*.proto'
    ],
    {
      cwd: projectDir,
      dot: false,
      absolute: false,
      ignore: ['**/node_modules/**', '**/dist/**', '**/build/**']
    }
  );

  if (files.some((f) => /\.controller\.ts$/i.test(f))) scores.nestjs += 2;
  if (files.some((f) => /routes\.ts$/i.test(f) || /\.routes\.ts$/i.test(f))) {
    scores.nestjs += 1;
    scores.hono += 2;
    scores.express += 2;
  }
  if (files.some((f) => /router\.(js|ts)$/i.test(f))) scores.express += 3;
  if (files.some((f) => /hono/i.test(f))) scores.hono += 3;

  if (files.some((f) => /grpc.*\.controller\.ts$/i.test(f) || /\.grpc\./i.test(f))) {
    scores.nestjs += 3;
    grpcDetected = true;
  }
  if (files.some((f) => /\.proto$/i.test(f))) {
    scores.nestjs += 2;
    grpcDetected = true;
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  const second = ranked[1];

  if (!top || top[1] === 0) {
    return { framework: 'auto', grpcDetected: false, reason: 'No strong framework signal found.' };
  }

  if (second && second[1] === top[1]) {
    return { framework: 'auto', grpcDetected, reason: 'Multiple framework signals detected.' };
  }

  return {
    framework: top[0],
    grpcDetected,
    reason: 'Detected from package dependencies and source files.'
  };
}

async function initConfig({ baseDir } = {}) {
  const prompt = getPrompt();
  if (!prompt) {
    throw new Error('Inquirer prompt not available. Please use Node 18+ and reinstall dependencies.');
  }

  const resolved = await resolveConfigPath(undefined, baseDir);
  const targetPath = resolved.path;
  const projectDir = resolved.baseDir || process.cwd();

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

  const detected = await detectFramework(projectDir);
  if (detected.framework !== 'auto') {
    const grpcNote = detected.grpcDetected ? ' + gRPC/microservice controllers' : '';
    info(`Detected framework: ${prettyFramework(detected.framework)}${grpcNote}`);
  } else {
    info(detected.reason);
  }

  const frameworkChoices = [
    { name: 'Auto-detect', value: 'auto' },
    { name: 'NestJS (HTTP + gRPC)', value: 'nestjs' },
    { name: 'Express', value: 'express' },
    { name: 'Hono', value: 'hono' }
  ];

  const answers = await prompt([
    {
      type: 'list',
      name: 'framework',
      message: 'Which framework do you use?',
      choices: frameworkChoices,
      default: detected.framework
    },
    {
      type: 'confirm',
      name: 'advanced',
      message: 'Customize file glob patterns manually?',
      default: false
    },
    {
      type: 'input',
      name: 'include',
      message: 'Glob(s) for route/controller files (comma-separated):',
      default: (a) => getIncludePreset(a.framework).join(','),
      when: (a) => a.advanced
    },
    {
      type: 'input',
      name: 'exclude',
      message: 'Glob(s) to exclude (comma-separated):',
      default: DEFAULT_CONFIG.sources.exclude.join(','),
      when: (a) => a.advanced
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

  const include = answers.advanced
    ? parseCsv(answers.include)
    : getIncludePreset(answers.framework);
  const exclude = answers.advanced
    ? parseCsv(answers.exclude)
    : DEFAULT_CONFIG.sources.exclude;

  const config = {
    framework: answers.framework,
    sources: {
      include,
      exclude,
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
      groupBy: 'folder'
    }
  };

  const contents = `module.exports = ${JSON.stringify(config, null, 2)};\n`;
  await fs.outputFile(targetPath, contents);
  info(`Saved config to ${targetPath}`);
  success('Done');
}

module.exports = { initConfig };
