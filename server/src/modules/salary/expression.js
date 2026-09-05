import { Parser } from 'expr-eval';
import { badRequest } from '../../lib/errors.js';

// expr-eval parses a small arithmetic grammar of its own; it never touches the
// JS runtime, so a rule author cannot reach globals, require, or the process.
// Assignment and member-assignment are disabled so an expression can only read
// from the context it is handed.
const parser = new Parser({
  operators: {
    add: true,
    subtract: true,
    multiply: true,
    divide: true,
    remainder: true,
    power: true,
    factorial: false,
    comparison: true,
    logical: true,
    conditional: true,
    concatenate: false,
    in: true,
    assignment: false,
  },
});

// A deliberately small helper set. Anything not listed is unavailable.
// `round`, `floor`, `ceil`, `abs`, `min` and `max` are already built into
// expr-eval's grammar as unary/variadic operators; `round` in particular is
// parsed as unary, so two-argument rounding needs its own name.
Object.assign(parser.functions, {
  roundTo: (v, dp = 2) => Number(Number(v).toFixed(dp)),
});

const CACHE = new Map();

const compile = (source) => {
  if (CACHE.has(source)) return CACHE.get(source);
  let expr;
  try {
    expr = parser.parse(source);
  } catch (err) {
    throw badRequest(`Invalid expression: ${err.message}`, { expression: source });
  }
  CACHE.set(source, expr);
  return expr;
};

// Rules are authored in Odoo's idiom, e.g. categories['BASIC'] or
// result = categories['BASIC']. Normalise both into plain expr-eval syntax.
export function normalise(source) {
  return String(source)
    .replace(/^\s*result\s*=\s*/i, '')
    .replace(/\bcategories\s*\[\s*['"]([A-Za-z0-9_]+)['"]\s*\]/g, 'categories.$1')
    .replace(/\brules\s*\[\s*['"]([A-Za-z0-9_]+)['"]\s*\]/g, 'rules.$1')
    .trim();
}

// Variables an expression may reference, reported back to the UI for hints.
export const contextKeys = (ctx) => ({
  scalars: Object.keys(ctx).filter((k) => typeof ctx[k] !== 'object'),
  categories: Object.keys(ctx.categories ?? {}),
  rules: Object.keys(ctx.rules ?? {}),
});

export function evaluate(source, context) {
  const expr = compile(normalise(source));

  // Any identifier the context does not define would evaluate to undefined and
  // silently poison the payslip, so reject it up front with a clear message.
  const unknown = expr
    .variables({ withMembers: false })
    .filter((v) => !(v in context) && !(v in parser.functions));
  if (unknown.length) {
    throw badRequest(
      `Expression references unknown variable(s): ${unknown.join(', ')}`,
      { expression: source, unknown },
    );
  }

  let value;
  try {
    value = expr.evaluate(context);
  } catch (err) {
    throw badRequest(`Expression failed: ${err.message}`, { expression: source });
  }

  if (typeof value === 'boolean') return value;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw badRequest(
      `Expression must produce a finite number, got ${JSON.stringify(value)}`,
      { expression: source },
    );
  }
  return value;
}

// Used by the rule form's "validate" action so authors get feedback before a
// payrun, checked against a representative sample context.
export function validateExpression(source, sampleContext) {
  try {
    const value = evaluate(source, sampleContext);
    return { valid: true, sample: value };
  } catch (err) {
    return { valid: false, error: err.message, details: err.details };
  }
}
