const traverse = require('@babel/traverse').default;

function getPropertyName(node) {
    if (!node) return null;
    if (node.type === 'Identifier') return node.name;
    if (node.type === 'StringLiteral') return node.value;
    return null;
}

function getStringLiteral(node) {
    if (!node) return '';
    if (node.type === 'StringLiteral') return node.value;
    return '';
}

function getObjectProperty(node, keyName) {
    if (!node || node.type !== 'ObjectExpression') return null;
    for (const prop of node.properties) {
        if (prop.type !== 'ObjectProperty') continue;
        const name = getPropertyName(prop.key);
        if (name === keyName) return prop.value;
    }
    return null;
}

function resolveZodSchema(node, schemaDefs, depth = 0) {
    if (!node || depth > 10) return { type: 'string' }; // Prevent infinite recursion

    // Handle identifier references (e.g. userSchema)
    if (node.type === 'Identifier') {
        if (schemaDefs.has(node.name)) {
            // Recursively resolve the stored definition
            return resolveZodSchema(schemaDefs.get(node.name), schemaDefs, depth + 1);
        }
        return { type: 'object' }; // Fallback
    }

    // Handle call chains: z.string().min(3).openapi({...})
    if (node.type === 'CallExpression') {
        const { callee } = node;

        if (callee.type === 'MemberExpression') {
            const methodName = callee.property.name;

            // Primitives call usage: z.string(), z.number(), z.boolean()
            if (methodName === 'string') return { type: 'string' };
            if (methodName === 'number') return { type: 'number' };
            if (methodName === 'boolean') return { type: 'boolean' };

            // z.object({...})
            if (methodName === 'object') {
                const arg = node.arguments[0];
                if (arg && arg.type === 'ObjectExpression') {
                    const properties = {};
                    const required = [];
                    for (const prop of arg.properties) {
                        if (prop.type !== 'ObjectProperty') continue;
                        const name = getPropertyName(prop.key);
                        if (!name) continue;
                        const propSchema = resolveZodSchema(prop.value, schemaDefs, depth + 1);
                        properties[name] = propSchema;
                        if (!propSchema.optional) required.push(name);
                    }
                    return { type: 'object', properties, required: required.length ? required : undefined };
                }
                return { type: 'object' };
            }

            // z.array(schema)
            if (methodName === 'array') {
                const arg = node.arguments[0];
                return {
                    type: 'array',
                    items: resolveZodSchema(arg, schemaDefs, depth + 1)
                };
            }

            // Check for .openapi({ example: ... })
            if (methodName === 'openapi') {
                const baseSchema = resolveZodSchema(callee.object, schemaDefs, depth + 1);
                const arg = node.arguments[0];
                const example = getObjectProperty(arg, 'example');

                if (example) {
                    if (example.type === 'StringLiteral') baseSchema.example = example.value;
                    if (example.type === 'NumericLiteral') baseSchema.example = example.value;
                    if (example.type === 'BooleanLiteral') baseSchema.example = example.value;
                }
                return baseSchema;
            }

            // Check for .optional()
            if (methodName === 'optional') {
                const base = resolveZodSchema(callee.object, schemaDefs, depth + 1);
                base.optional = true;
                return base;
            }

            // Generic fallback for other chaining methods (.min, .max, .email, etc.)
            // We recurse on the object being chained on.
            return resolveZodSchema(callee.object, schemaDefs, depth + 1);
        }
    }

    // Handle z.string, z.number access (MemberExpression not called yet, or part of chain root)
    if (node.type === 'MemberExpression') {
        const name = node.property.name;
        if (name === 'string') return { type: 'string' };
        if (name === 'number') return { type: 'number' };
        if (name === 'boolean') return { type: 'boolean' };

        // Recurse up if it's something like z.string
        if (node.object) return resolveZodSchema(node.object, schemaDefs, depth + 1);
    }

    return { type: 'string' };
}

module.exports = { resolveZodSchema };
