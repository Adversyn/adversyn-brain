// Minimal JSON Schema validator scoped to the Nova task schema.
// Zero deps — Node built-ins only. Validates required, type, enum, const,
// minLength, maxLength, minItems, additionalProperties.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(HERE, '../../schemas/nova_task.schema.json');

let _schemaCache = null;
export function loadSchema() {
  if (_schemaCache) return _schemaCache;
  _schemaCache = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  return _schemaCache;
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function validateProp(value, propSchema, propPath, errors) {
  if (value === undefined) return;
  const expected = propSchema.type;
  if (expected) {
    const got = typeOf(value);
    const ok = Array.isArray(expected) ? expected.includes(got) : got === expected;
    if (!ok) {
      errors.push(`${propPath}: expected type ${JSON.stringify(expected)}, got ${got}`);
      return;
    }
  }
  if (propSchema.enum && !propSchema.enum.includes(value)) {
    errors.push(`${propPath}: value ${JSON.stringify(value)} not in enum ${JSON.stringify(propSchema.enum)}`);
  }
  if (Object.prototype.hasOwnProperty.call(propSchema, 'const') && value !== propSchema.const) {
    errors.push(`${propPath}: must equal ${JSON.stringify(propSchema.const)}, got ${JSON.stringify(value)}`);
  }
  if (typeof value === 'string') {
    if (propSchema.minLength != null && value.length < propSchema.minLength) {
      errors.push(`${propPath}: shorter than minLength ${propSchema.minLength}`);
    }
    if (propSchema.maxLength != null && value.length > propSchema.maxLength) {
      errors.push(`${propPath}: longer than maxLength ${propSchema.maxLength}`);
    }
  }
  if (Array.isArray(value)) {
    if (propSchema.minItems != null && value.length < propSchema.minItems) {
      errors.push(`${propPath}: fewer than minItems ${propSchema.minItems}`);
    }
    if (propSchema.items) {
      value.forEach((item, i) => validateProp(item, propSchema.items, `${propPath}[${i}]`, errors));
    }
  }
}

export function validateNovaTask(task) {
  const errors = [];
  const schema = loadSchema();
  if (typeOf(task) !== 'object') {
    return { valid: false, errors: ['root: expected object'] };
  }
  for (const req of schema.required || []) {
    if (task[req] === undefined) errors.push(`missing required field: ${req}`);
  }
  if (schema.additionalProperties === false) {
    for (const k of Object.keys(task)) {
      if (!schema.properties[k]) errors.push(`unknown field: ${k}`);
    }
  }
  for (const [k, v] of Object.entries(task)) {
    const propSchema = schema.properties[k];
    if (!propSchema) continue;
    validateProp(v, propSchema, k, errors);
  }
  if (task.agent_lane === 'multi-agent' && (!task.primary_agent || task.primary_agent === 'none')) {
    errors.push("primary_agent must be 'claude' or 'codex' when agent_lane is 'multi-agent'");
  }
  return { valid: errors.length === 0, errors };
}

export function applySchemaDefaults(task) {
  const out = { ...task };
  if (out.priority === undefined) out.priority = 'normal';
  if (out.primary_agent === undefined) out.primary_agent = 'none';
  if (out.affected_routes === undefined) out.affected_routes = [];
  if (out.affected_files === undefined) out.affected_files = [];
  if (out.qa_requirements === undefined) out.qa_requirements = [];
  if (out.forbidden_actions === undefined) out.forbidden_actions = [];
  if (out.requires_human_approval === undefined) out.requires_human_approval = false;
  return out;
}
