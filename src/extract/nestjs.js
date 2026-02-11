const traverse = require('@babel/traverse').default;
const path = require('path');
const fs = require('fs-extra');
const { parseFile } = require('./ast');
const { joinPaths, normalizePath, toKey } = require('../utils');

const HTTP_DECORATORS = {
  Get: 'GET',
  Post: 'POST',
  Put: 'PUT',
  Patch: 'PATCH',
  Delete: 'DELETE',
  Options: 'OPTIONS',
  Head: 'HEAD'
};

const OPTIONAL_DECORATORS = new Set(['IsOptional', 'ApiPropertyOptional']);
const TYPE_DECORATORS = new Map([
  ['IsString', 'string'],
  ['IsEmail', 'string'],
  ['IsUUID', 'string'],
  ['IsInt', 'number'],
  ['IsNumber', 'number'],
  ['Min', 'number'],
  ['Max', 'number'],
  ['IsBoolean', 'boolean']
]);

function getDecoratorName(dec) {
  const expr = dec.expression;
  if (!expr) return null;
  if (expr.type === 'CallExpression') {
    if (expr.callee.type === 'Identifier') return expr.callee.name;
  }
  if (expr.type === 'Identifier') return expr.name;
  return null;
}

function getDecoratorArgs(dec) {
  const expr = dec.expression;
  if (expr && expr.type === 'CallExpression') return expr.arguments || [];
  return [];
}

function getStringArg(dec) {
  const args = getDecoratorArgs(dec);
  const first = args[0];
  if (!first) return '';
  if (first.type === 'StringLiteral') return first.value;
  if (first.type === 'TemplateLiteral' && first.quasis.length === 1) {
    return first.quasis[0].value.cooked || '';
  }
  return '';
}

function getTagsFromDecorator(dec) {
  const args = getDecoratorArgs(dec);
  const tags = [];
  for (const arg of args) {
    if (arg.type === 'StringLiteral') tags.push(arg.value);
  }
  return tags;
}

function getSummaryFromDecorator(dec) {
  const args = getDecoratorArgs(dec);
  const first = args[0];
  if (!first || first.type !== 'ObjectExpression') return null;
  for (const prop of first.properties) {
    if (prop.type !== 'ObjectProperty') continue;
    if (prop.key.type === 'Identifier' && prop.key.name === 'summary') {
      if (prop.value.type === 'StringLiteral') return prop.value.value;
    }
  }
  return null;
}

function getPropertyName(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'StringLiteral') return node.value;
  return null;
}

function getDecoratorObjectArg(dec) {
  const args = getDecoratorArgs(dec);
  const first = args[0];
  if (first && first.type === 'ObjectExpression') return first;
  return null;
}

function getPropMetaFromDecorators(decorators) {
  let optional = false;
  let example;
  let overrideType;

  for (const dec of decorators || []) {
    const name = getDecoratorName(dec);
    if (!name) continue;
    if (OPTIONAL_DECORATORS.has(name)) optional = true;
    if (TYPE_DECORATORS.has(name)) overrideType = TYPE_DECORATORS.get(name);

    if (name === 'ApiProperty' || name === 'ApiPropertyOptional') {
      const obj = getDecoratorObjectArg(dec);
      if (name === 'ApiPropertyOptional') optional = true;
      if (obj) {
        for (const prop of obj.properties) {
          if (prop.type !== 'ObjectProperty') continue;
          if (prop.key.type !== 'Identifier') continue;
          if (prop.key.name === 'required' && prop.value.type === 'BooleanLiteral') {
            if (prop.value.value === false) optional = true;
          }
          if (prop.key.name === 'example') {
            if (prop.value.type === 'StringLiteral' || prop.value.type === 'NumericLiteral' || prop.value.type === 'BooleanLiteral') {
              example = prop.value.value;
            }
          }
          if (prop.key.name === 'type' && prop.value.type === 'Identifier') {
            overrideType = prop.value.name.toLowerCase();
          }
        }
      }
    }
  }

  return { optional, example, overrideType };
}

function collectDtoSchemasFromAst(ast) {
  const dtoMap = new Map();

  traverse(ast, {
    ClassDeclaration(path) {
      const classNode = path.node;
      if (!classNode.id || !classNode.id.name) return;
      const className = classNode.id.name;
      const props = [];

      for (const member of classNode.body.body || []) {
        if (member.type !== 'ClassProperty') continue;
        const name = getPropertyName(member.key);
        if (!name) continue;
        const meta = getPropMetaFromDecorators(member.decorators || []);
        const optional = member.optional === true || meta.optional;
        const typeNode = member.typeAnnotation ? member.typeAnnotation.typeAnnotation : null;
        props.push({ name, optional, typeNode, example: meta.example, overrideType: meta.overrideType });
      }

      if (props.length) dtoMap.set(className, { name: className, props });
    }
  });

  return dtoMap;
}

function collectImportMap(ast, filePath) {
  const map = new Map();
  const baseDir = path.dirname(filePath);

  traverse(ast, {
    ImportDeclaration(path) {
      const node = path.node;
      const source = node.source.value;
      if (!source || !source.startsWith('.')) return;
      const abs = resolveImportFile(baseDir, source);
      if (!abs) return;
      for (const spec of node.specifiers || []) {
        if (spec.type === 'ImportSpecifier' || spec.type === 'ImportDefaultSpecifier') {
          map.set(spec.local.name, abs);
        }
      }
    }
  });

  return map;
}

function resolveImportFile(baseDir, source) {
  const candidates = [
    path.resolve(baseDir, `${source}.ts`),
    path.resolve(baseDir, `${source}.tsx`),
    path.resolve(baseDir, `${source}.js`),
    path.resolve(baseDir, `${source}.jsx`),
    path.resolve(baseDir, source, 'index.ts'),
    path.resolve(baseDir, source, 'index.js')
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

async function collectDtoSchemas(ast, filePath) {
  const dtoMap = collectDtoSchemasFromAst(ast);
  const importMap = collectImportMap(ast, filePath);
  const visited = new Set([filePath]);

  for (const [, importFile] of importMap.entries()) {
    if (visited.has(importFile)) continue;
    visited.add(importFile);
    try {
      const importedAst = await parseFile(importFile);
      const importedDtos = collectDtoSchemasFromAst(importedAst);
      for (const [name, dto] of importedDtos.entries()) {
        if (!dtoMap.has(name)) dtoMap.set(name, dto);
      }
    } catch (err) {
      // Ignore missing or unparsable imports
    }
  }

  return dtoMap;
}

function schemaFromTypeNode(typeNode, dtoMap, depth = 0, memo = new Map(), meta = {}) {
  if (!typeNode) {
    if (meta.overrideType) return { type: meta.overrideType, example: meta.example };
    return { type: 'object', example: meta.example };
  }

  if (typeNode.type === 'TSStringKeyword') return { type: 'string', example: meta.example };
  if (typeNode.type === 'TSNumberKeyword') return { type: 'number', example: meta.example };
  if (typeNode.type === 'TSBooleanKeyword') return { type: 'boolean', example: meta.example };

  if (typeNode.type === 'TSArrayType') {
    return {
      type: 'array',
      items: schemaFromTypeNode(typeNode.elementType, dtoMap, depth + 1, memo)
    };
  }

  if (typeNode.type === 'TSTypeReference') {
    if (typeNode.typeName.type === 'Identifier') {
      const name = typeNode.typeName.name;
      if (name === 'Array' && typeNode.typeParameters && typeNode.typeParameters.params.length === 1) {
        return {
          type: 'array',
          items: schemaFromTypeNode(typeNode.typeParameters.params[0], dtoMap, depth + 1, memo)
        };
      }
      if (dtoMap.has(name) && depth < 2) {
        return buildSchemaForDto(name, dtoMap, depth + 1, memo);
      }
    }
  }

  if (typeNode.type === 'TSTypeLiteral') {
    const properties = {};
    for (const member of typeNode.members || []) {
      if (member.type !== 'TSPropertySignature') continue;
      const name = getPropertyName(member.key);
      if (!name) continue;
      const propSchema = schemaFromTypeNode(member.typeAnnotation?.typeAnnotation, dtoMap, depth + 1, memo);
      properties[name] = propSchema;
    }
    return { type: 'object', properties };
  }

  if (meta.overrideType) return { type: meta.overrideType, example: meta.example };
  return { type: 'object', example: meta.example };
}

function buildSchemaForDto(dtoName, dtoMap, depth = 0, memo = new Map()) {
  if (memo.has(dtoName)) return memo.get(dtoName);
  const dto = dtoMap.get(dtoName);
  if (!dto) return { type: 'object' };

  const schema = { type: 'object', properties: {} };
  memo.set(dtoName, schema);

  const required = [];
  for (const prop of dto.props) {
    const propSchema = schemaFromTypeNode(prop.typeNode, dtoMap, depth + 1, memo, prop);
    schema.properties[prop.name] = propSchema;
    if (!prop.optional) required.push(prop.name);
  }
  if (required.length) schema.required = required;

  return schema;
}

function getParamDecorators(paramNode, dtoSchemas) {
  const decoratorTarget = paramNode.decorators ? paramNode : paramNode.left || paramNode;
  const decorators = decoratorTarget.decorators || [];
  const params = [];
  const query = [];
  let body = null;

  for (const dec of decorators) {
    const name = getDecoratorName(dec);
    if (!name) continue;
    const arg = getStringArg(dec);
    if (name === 'Param') {
      if (arg) params.push({ name: arg, required: true });
    }
    if (name === 'Query') {
      if (arg) {
        query.push({ name: arg, required: false });
      } else {
        // @Query() query: SearchDto
        // Check if there is a type annotation that maps to a DTO
        const typeNode = decoratorTarget.typeAnnotation ? decoratorTarget.typeAnnotation.typeAnnotation : null;
        if (typeNode && typeNode.type === 'TSTypeReference' && typeNode.typeName.type === 'Identifier') {
          const dtoName = typeNode.typeName.name;
          // Build schema to extract properties
          // Use a temporary memo to avoid polluting global state if we were caching heavily, but here it's fine
          const schema = buildSchemaForDto(dtoName, dtoSchemas);
          if (schema && schema.properties) {
            for (const [key, val] of Object.entries(schema.properties)) {
              // Determine if required based on schema.required array
              const isRequired = schema.required && schema.required.includes(key);
              query.push({ name: key, required: !!isRequired });
            }
          }
        }
      }
    }
    if (name === 'Body') {
      const typeNode = decoratorTarget.typeAnnotation ? decoratorTarget.typeAnnotation.typeAnnotation : null;
      body = schemaFromTypeNode(typeNode, dtoSchemas);
    }
  }

  return { params, query, body };
}

async function extractNestJsEndpoints(filePath) {
  const ast = await parseFile(filePath);
  const endpoints = [];
  const dtoSchemas = await collectDtoSchemas(ast, filePath);

  traverse(ast, {
    ClassDeclaration(path) {
      const classNode = path.node;
      const decorators = classNode.decorators || [];
      let basePath = '';
      let tags = [];
      for (const dec of decorators) {
        const name = getDecoratorName(dec);
        if (name === 'Controller') {
          basePath = getStringArg(dec);
        }
        if (name === 'ApiTags') {
          tags = tags.concat(getTagsFromDecorator(dec));
        }
      }

      const body = classNode.body.body || [];
      for (const memberNode of body) {
        const isMethod = memberNode.type === 'ClassMethod';
        const isPropertyWithFn =
          memberNode.type === 'ClassProperty' &&
          memberNode.value &&
          (memberNode.value.type === 'ArrowFunctionExpression' || memberNode.value.type === 'FunctionExpression');

        if (!isMethod && !isPropertyWithFn) continue;

        const methodDecorators = memberNode.decorators || [];
        let httpMethod = null;
        let methodPath = '';
        let description = null;

        for (const dec of methodDecorators) {
          const name = getDecoratorName(dec);
          if (HTTP_DECORATORS[name]) {
            httpMethod = HTTP_DECORATORS[name];
            methodPath = getStringArg(dec);
          }
          if (name === 'ApiOperation') {
            description = getSummaryFromDecorator(dec) || description;
          }
        }

        if (!httpMethod) continue;

        const fullPath = normalizePath(joinPaths(basePath, methodPath));
        const params = [];
        const query = [];
        let bodySchema = null;

        const paramList = isMethod ? memberNode.params || [] : memberNode.value.params || [];
        for (const paramNode of paramList) {
          const res = getParamDecorators(paramNode, dtoSchemas);
          params.push(...res.params);
          query.push(...res.query);
          if (res.body) bodySchema = res.body;
        }

        const endpoint = {
          method: httpMethod,
          path: fullPath,
          description: description || `${httpMethod} ${fullPath}`,
          tags: tags.length ? tags : undefined,
          parameters: {
            path: params.length ? params : undefined,
            query: query.length ? query : undefined,
            body: bodySchema || undefined
          },
          filePath,
          key: toKey(httpMethod, fullPath)
        };
        endpoints.push(endpoint);
      }
    }
  });

  return endpoints;
}

module.exports = { extractNestJsEndpoints };
