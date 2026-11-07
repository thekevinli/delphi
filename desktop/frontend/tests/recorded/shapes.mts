/**
 * Holds the desktop's idea of a Memory answer against the backend's.
 *
 * Three things describe one answer and nothing kept them in step: what the
 * backend sends (`responses.json`, written by `record.mts`), the type the
 * frontend reads it as (`app/lib/api.ts` and its neighbours), and the fixtures
 * the browser specs and harnesses serve in its place. Each spec passes against
 * its own fixture, so a key renamed on one side only is a green suite and a
 * broken app. This compares their keys and value types:
 *
 * - every recorded answer against its type, both ways: a key the type does not
 *   declare, a key the type requires that the backend does not always send, a
 *   value of another type, or a value outside the type's literals;
 * - every fixture against the recorded answers of its route: a fixture key the
 *   backend never sends, a key the type requires that the fixture leaves out,
 *   or a value of a type neither the backend nor the type allows there.
 *
 * Fixtures are read from the specs' source with the TypeScript checker, never
 * by running them. Wherever a spec fulfils a route, answers a `case` of a route
 * switch, or returns a `Response`, what it serves is the fixture, and its route
 * is read from the `page.route` pattern, the `case` label, or the `pathname`
 * test around it. A fixture is read as written — object literals, spreads,
 * constants and what a local helper returns — and through the checker's type
 * only where the spec computes it, since nothing type-checks the specs.
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { parseSseFrames } from "../../app/lib/sse.ts";

const frontend = fileURLToPath(new URL("../../", import.meta.url));
const browserDir = join(frontend, "tests/browser");
const routeTypesFile = join(frontend, "tests/recorded/route-types.ts");

export type Sample = { case: string; status: number; json?: unknown; events?: Array<Record<string, unknown>> };
export type Recording = { backend: string; routes: Record<string, Sample[]> };
export type Finding = { id: string; message: string };

export type RouteSpec = {
  /** The type the frontend reads the answer as; null where it reads nothing of it. */
  type: string | null;
  /** An event stream: the type the frontend reads each kind of event as, by its `type`. */
  events?: Record<string, string>;
  /** Only these parts carry Memory data: `$.key` paths, or a pattern for top-level keys. */
  focus?: Array<string | RegExp>;
};

/**
 * Every route the recorder keeps, with how the desktop reads it. A route the
 * frontend calls under `/api/memory` that is in neither this nor
 * `UNRECORDED` fails the check, as does a listed route with nothing recorded.
 */
export const ROUTES: Record<string, RouteSpec> = {
  "GET /api/memory": { type: "MemoryOverview" },
  "GET /api/memory/domains": { type: "{ domains: MemoryDomain[] }" },
  "POST /api/memory/domains": { type: null },
  "PATCH /api/memory/domains/{slug}": { type: null },
  "DELETE /api/memory/domains/{slug}": { type: null },
  "GET /api/memory/pages": { type: "MemoryPageSummary[]" },
  "GET /api/memory/pages/{slug}": { type: "MemoryPageDetail" },
  "POST /api/memory/pages/move": { type: null },
  "POST /api/memory/pages/{slug}/rewrite": { type: "MaintenanceJob" },
  "GET /api/memory/neighborhood": { type: "MemoryNeighborhood" },
  "GET /api/memory/documents/{paperId}/neighborhood": { type: "MemoryDocumentNeighborhood" },
  "GET /api/memory/documents/{paperId}/filing": { type: "DocumentFilingState" },
  "GET /api/memory/documents/{paperId}/dependents": { type: "{ pages: MemoryDependentPage[] }" },
  "GET /api/memory/projects/{projectId}/dependents": { type: "{ pages: MemoryDependentPage[] }" },
  "POST /api/memory/documents/{paperId}/same-as": { type: "{ used: boolean }" },
  "GET /api/memory/backfill/papers": { type: "{ papers: BackfillCandidate[] }" },
  "POST /api/memory/backfill/papers": { type: "{ queued: number }" },
  "GET /api/memory/health": { type: "MemoryHealth" },
  "GET /api/memory/maintenance": { type: "MaintenanceSnapshot" },
  "POST /api/memory/maintenance/cancel": { type: "{ cancelled: number }" },
  "POST /api/memory/maintenance/jobs/{jobId}/retry": { type: null },
  "POST /api/memory/maintenance/drain": { type: null, events: {} },
  "POST /api/memory/sessions/release": { type: "{ released?: unknown }" },
  "POST /api/memory/lint": { type: null, events: {} },
  "POST /api/memory/reorganize/stream": { type: null, events: { done: "SseEvent & MemoryReorganization" } },
  // Memory data on routes of their own: the settings, search, and the Memory
  // chat (the general scope) with the lists it appears in.
  "GET /api/config": { type: "AppConfig", focus: [/memory/i] },
  "GET /api/search": { type: "SearchResponse", focus: ["$.results.memory", "$.results.conversations"] },
  "GET /api/conversations": { type: "DashboardConversation[]" },
  "GET /api/dashboard": { type: "DashboardData", focus: ["$.conversations"] },
  "GET /api/chat/conversations": { type: "ConversationCatalog" },
  "POST /api/chat/conversations": { type: "ConversationSummary" },
  "POST /api/chat/stream": { type: null, events: {} },
  "GET /api/chat": { type: "ChatThreadRead" },
};

/** Memory routes the frontend calls that answer bytes, not JSON. */
export const UNRECORDED = ["GET /api/memory/figures/{figureId}"];

/** Where the route types come from. A type renamed there fails here, by name. */
const TYPE_IMPORTS = `
import type { AppConfig, ChatThreadRead, DashboardConversation, DashboardData, DocumentFilingState, MemoryDocumentNeighborhood,
  MemoryDependentPage, MemoryDomain, MemoryHealth, MemoryNeighborhood, MemoryOverview, MemoryPageDetail, MemoryPageSummary,
  MemoryReorganization, MaintenanceJob, MaintenanceSnapshot } from "../../app/lib/api.ts";
import type { BackfillCandidate } from "../../app/lib/backfill.ts";
import type { SearchResponse } from "../../app/lib/search.ts";
import type { ConversationCatalog, ConversationSummary } from "../../app/lib/conversation-session.ts";
import type { SseEvent } from "../../app/lib/sse.ts";
`;

/**
 * Harness data handed to a component rather than served, with the answer it
 * stands for. Checked one way only: each key must be one the backend sends,
 * since the component's own input type may ask for less than the answer has.
 */
const HARNESS_FIXTURES = [
  { file: "FilingHarness.tsx", name: "record", route: "GET /api/memory/documents/{paperId}/filing", path: "$" },
  { file: "FilingHarness.tsx", name: "dropped", route: "GET /api/memory/documents/{paperId}/filing", path: "$.dropped" },
];

// ---------------------------------------------------------------------------
// Shapes: what a type, a fixture or a recorded value says a value may be.

type Kind = "string" | "number" | "boolean" | "null" | "array" | "object";
type Literal = string | number;
type Prop = { shape: Shape; optional: boolean };
type Shape = {
  any?: boolean;
  /** Written out in a fixture, rather than only declared by a type: worth holding against what was recorded. */
  written?: boolean;
  /** Each kind the value may be, with the only values it may take where those are listed. */
  kinds: Map<Kind, Set<Literal> | null>;
  element?: Shape;
  props?: Map<string, Prop>;
  index?: Shape;
};

const ANY: Shape = { any: true, kinds: new Map() };
const empty = (): Shape => ({ kinds: new Map() });
const kindOf = (value: unknown): Kind => value === null ? "null" : Array.isArray(value) ? "array" : typeof value as Kind;

function addKind(shape: Shape, kind: Kind, literal?: Literal) {
  const known = shape.kinds.get(kind);
  if (literal === undefined) shape.kinds.set(kind, null);
  else if (known === undefined) shape.kinds.set(kind, new Set([literal]));
  else known?.add(literal);
}

/** `into` widened to also allow `from`. Never mutates `from`. */
function merge(into: Shape, from: Shape): Shape {
  if (from.any) into.any = true;
  if (from.written) into.written = true;
  for (const [kind, literals] of from.kinds) {
    if (literals === null) into.kinds.set(kind, null);
    else for (const literal of literals) addKind(into, kind, literal);
  }
  if (from.element) into.element = merge(into.element ? merge(empty(), into.element) : empty(), from.element);
  if (from.index) into.index = merge(into.index ? merge(empty(), into.index) : empty(), from.index);
  if (from.props) {
    if (!into.props) into.props = new Map(from.props);
    else {
      const props = new Map<string, Prop>();
      for (const key of new Set([...into.props.keys(), ...from.props.keys()])) {
        const a = into.props.get(key), b = from.props.get(key);
        // A key only some members of a union carry is not one the value must have.
        props.set(key, { shape: a && b ? merge(merge(empty(), a.shape), b.shape) : (a ?? b)!.shape, optional: !a || !b || a.optional || b.optional });
      }
      into.props = props;
    }
  }
  return into;
}

function fromJson(value: unknown): Shape {
  const shape = empty();
  const kind = kindOf(value);
  if (kind === "array") {
    shape.kinds.set("array", null);
    shape.element = (value as unknown[]).reduce<Shape>((all, item) => merge(all, fromJson(item)), empty());
  } else if (kind === "object") {
    shape.kinds.set("object", null);
    shape.props = new Map(Object.entries(value as object).map(([key, entry]) => [key, { shape: fromJson(entry), optional: false }]));
  } else addKind(shape, kind, kind === "string" || kind === "number" ? value as Literal : undefined);
  return shape;
}

/** What a type allows, as the checker sees it. */
function shapeOfType(checker: ts.TypeChecker, type: ts.Type, seen = new Set<ts.Type>()): Shape {
  const flags = type.flags;
  if (flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter | ts.TypeFlags.NonPrimitive)) return ANY;
  if (type.isUnion()) return type.types.reduce<Shape>((all, member) => merge(all, shapeOfType(checker, member, seen)), empty());
  const shape = empty();
  if (type.isStringLiteral()) addKind(shape, "string", type.value);
  else if (type.isNumberLiteral()) addKind(shape, "number", type.value);
  else if (flags & (ts.TypeFlags.String | ts.TypeFlags.TemplateLiteral | ts.TypeFlags.StringMapping)) addKind(shape, "string");
  else if (flags & ts.TypeFlags.NumberLike) addKind(shape, "number");
  else if (flags & ts.TypeFlags.BooleanLike) addKind(shape, "boolean");
  else if (flags & ts.TypeFlags.Null) addKind(shape, "null");
  else if (flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Never)) return shape;
  else if (flags & ts.TypeFlags.Object || type.isIntersection()) {
    if (seen.has(type)) return ANY;
    seen = new Set(seen).add(type);
    if (checker.isArrayType(type) || checker.isTupleType(type)) {
      shape.kinds.set("array", null);
      shape.element = checker.getTypeArguments(type as ts.TypeReference).reduce<Shape>((all, item) => merge(all, shapeOfType(checker, item, seen)), empty());
      return shape;
    }
    const symbols = checker.getPropertiesOfType(type);
    if (checker.getSignaturesOfType(type, ts.SignatureKind.Call).length && !symbols.length) return shape;
    shape.kinds.set("object", null);
    shape.props = new Map();
    for (const symbol of symbols) {
      const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
      const propType = declaration ? checker.getTypeOfSymbolAtLocation(symbol, declaration) : checker.getTypeOfSymbol(symbol);
      if (checker.getSignaturesOfType(propType, ts.SignatureKind.Call).length && !checker.getPropertiesOfType(propType).length) continue;
      const prop = shapeOfType(checker, propType, seen);
      // An untyped fixture's own words, which the checker widened: `kind: "memory_chat"`.
      if (declaration && ts.isPropertyAssignment(declaration) && prop.kinds.get("string") === null) {
        const value = declaration.initializer;
        if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) prop.kinds.set("string", new Set([value.text]));
      }
      shape.props.set(symbol.name, { shape: prop, optional: Boolean(symbol.flags & ts.SymbolFlags.Optional) });
    }
    const index = checker.getIndexTypeOfType(type, ts.IndexKind.String);
    if (index) shape.index = shapeOfType(checker, index, seen);
  } else return ANY;
  return shape;
}

/** The function a call names, when it is one of the fixture files' own, with what it returns. */
function returned(checker: ts.TypeChecker, call: ts.CallExpression, fixtures: Set<string>): ts.Expression[] | undefined {
  let symbol = checker.getSymbolAtLocation(call.expression);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  let declaration: ts.Node | undefined = symbol?.valueDeclaration;
  if (!declaration || !fixtures.has(declaration.getSourceFile().fileName)) return undefined;
  if (ts.isVariableDeclaration(declaration)) declaration = declaration.initializer;
  if (!declaration || !(ts.isFunctionDeclaration(declaration) || ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration)) || !declaration.body) return undefined;
  if (!ts.isBlock(declaration.body)) return [declaration.body];
  const results: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isReturnStatement(node) && node.expression) results.push(node.expression);
    else if (!ts.isFunctionLike(node)) ts.forEachChild(node, visit);
  };
  visit(declaration.body);
  return results.length ? results : undefined;
}

/**
 * What a fixture expression serves, read as written: literals, spreads, the
 * constants and helpers of the fixture files. The checker's type stands in
 * only for what the spec computes, and for a value that comes from app code.
 */
function shapeOfExpression(checker: ts.TypeChecker, node: ts.Expression, fixtures: Set<string>, depth = 0): Shape {
  node = unwrap(node);
  if (depth > 24) return ANY;
  const next = (child: ts.Expression) => shapeOfExpression(checker, child, fixtures, depth + 1);
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node)) return next(node.expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return addKindTo("string", node.text);
  if (ts.isTemplateExpression(node)) return addKindTo("string");
  if (ts.isNumericLiteral(node)) return addKindTo("number", Number(node.text));
  if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)) return addKindTo("number");
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return addKindTo("boolean");
  if (node.kind === ts.SyntaxKind.NullKeyword) return addKindTo("null");
  // An arm the check cannot read leaves the other to be checked.
  const either = (a: Shape, b: Shape) => a.any ? b : b.any ? a : merge(a, b);
  if (ts.isConditionalExpression(node)) return either(next(node.whenTrue), next(node.whenFalse));
  if (ts.isBinaryExpression(node) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)) {
    return either(next(node.left), next(node.right));
  }
  if (ts.isArrayLiteralExpression(node)) {
    const shape: Shape = { kinds: new Map(), written: true };
    shape.kinds.set("array", null);
    shape.element = node.elements.reduce<Shape>((all, item) => merge(all, ts.isSpreadElement(item) ? next(item.expression).element ?? ANY : next(item)), empty());
    return shape;
  }
  if (ts.isObjectLiteralExpression(node)) {
    const shape: Shape = { kinds: new Map(), written: true };
    shape.kinds.set("object", null);
    shape.props = new Map();
    for (const entry of node.properties) {
      if (ts.isSpreadAssignment(entry)) {
        const spread = next(entry.expression);
        if (spread.any || spread.index) shape.index = merge(shape.index ?? empty(), spread.index ?? ANY);
        for (const [key, prop] of spread.props ?? []) shape.props.set(key, prop);
      } else if (ts.isPropertyAssignment(entry) && !ts.isComputedPropertyName(entry.name)) {
        shape.props.set(entry.name.getText().replace(/^["']|["']$/g, ""), { shape: next(entry.initializer), optional: false });
      } else if (ts.isShorthandPropertyAssignment(entry)) {
        shape.props.set(entry.name.text, { shape: next(entry.name), optional: false });
      }
    }
    return shape;
  }
  if (ts.isIdentifier(node)) {
    const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer && fixtures.has(declaration.getSourceFile().fileName)
      && ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) return next(declaration.initializer);
  }
  if (ts.isCallExpression(node)) {
    const results = returned(checker, node, fixtures);
    if (results) return results.reduce<Shape>((all, result) => merge(all, next(result)), empty());
  }
  return shapeOfType(checker, checker.getTypeAtLocation(node));
}

const unwrap = (node: ts.Expression): ts.Expression => ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;

function addKindTo(kind: Kind, literal?: Literal): Shape {
  const shape = empty();
  addKind(shape, kind, literal);
  return shape;
}

// ---------------------------------------------------------------------------
// The comparisons.

type Scope = (path: string) => boolean;
type Report = (path: string, what: string, detail: string) => void;

function scopeOf(focus: RouteSpec["focus"]): Scope {
  if (!focus) return () => true;
  return path => path === "$" || focus.some(part => typeof part === "string"
    ? path === part || path.startsWith(`${part}.`) || path.startsWith(`${part}[`) || part.startsWith(`${path}.`) || part.startsWith(`${path}[`)
    : part.test(path.split(/[.[]/)[1] ?? ""));
}

const describe = (shape: Shape) => [...shape.kinds.keys()].join(" | ") || "nothing";
const quote = (value: unknown) => JSON.stringify(value).slice(0, 80);
const isObject = (value: unknown): value is Record<string, unknown> => kindOf(value) === "object";

/** Samples and a type's shape, followed along `$.a[].b`. */
function at(samples: unknown[], shape: Shape | undefined, path: string): { samples: unknown[]; shape: Shape | undefined } {
  for (const step of path.match(/\.[^.[]+|\[\]/g) ?? []) {
    if (step === "[]") {
      samples = samples.flatMap(value => Array.isArray(value) ? value : []);
      shape = shape?.any ? shape : shape?.element;
    } else {
      const key = step.slice(1);
      samples = samples.flatMap(value => isObject(value) && key in value ? [value[key]] : []);
      shape = shape?.any ? shape : shape?.props?.get(key)?.shape ?? shape?.index;
    }
  }
  return { samples, shape };
}

/** Recorded answers against the type the frontend reads them as. */
function holdRecorded(type: Shape, samples: unknown[], path: string, scope: Scope, typeName: string, report: Report) {
  if (type.any || !samples.length) return;
  for (const value of samples) {
    const kind = kindOf(value);
    const literals = type.kinds.get(kind);
    if (!type.kinds.has(kind)) report(path, `recorded ${kind} where api.ts has ${describe(type)}`, `e.g. ${quote(value)}`);
    else if (literals && !literals.has(value as Literal)) report(path, `recorded value ${quote(value)} is not one api.ts names`, `api.ts allows ${[...literals].map(quote).join(", ")}`);
  }
  const elements = samples.filter(Array.isArray).flat();
  if (type.element && elements.length) holdRecorded(type.element, elements, `${path}[]`, scope, typeName, report);
  const objects = samples.filter(isObject);
  if (!objects.length || !type.props) return;
  for (const key of new Set(objects.flatMap(Object.keys))) {
    const sub = `${path}.${key}`;
    if (!scope(sub)) continue;
    const values = objects.filter(value => key in value).map(value => value[key]);
    const declared = type.props.get(key)?.shape ?? type.index;
    if (!declared) report(sub, "recorded key not in the api.ts type", `${typeName} does not declare it; the backend sent ${quote(values[0])}`);
    else holdRecorded(declared, values, sub, scope, typeName, report);
  }
  for (const [key, prop] of type.props) {
    const sub = `${path}.${key}`;
    if (prop.optional || !scope(sub)) continue;
    const lacking = objects.filter(value => !(key in value)).length;
    if (lacking) report(sub, "api.ts requires a key the backend does not always send", `${lacking} of ${objects.length} recorded objects lack it`);
  }
}

/**
 * A fixture against what the backend sent in its place. Where the recordings
 * have not seen a kind of value the type allows, as a `null` the backend sends
 * only sometimes, the type's word is taken for it.
 */
function holdFixture(fixture: Shape, samples: unknown[], declared: Shape | undefined, path: string, scope: Scope, oneWay: boolean, report: Report) {
  if (fixture.any || !fixture.kinds.size || !samples.length) return;
  const recorded = new Set(samples.map(kindOf));
  for (const [kind, literals] of fixture.kinds) {
    if (!recorded.has(kind) && !declared?.kinds.has(kind) && !declared?.any) {
      report(path, `fixture ${kind} where the backend sends ${[...recorded].join(" | ")}`, `api.ts has ${declared ? describe(declared) : "no type here"}`);
    }
    const allowed = declared?.kinds.get(kind);
    for (const literal of literals ?? []) {
      if (allowed && !allowed.has(literal)) report(path, `fixture value ${quote(literal)} is not one api.ts names`, `api.ts allows ${[...allowed].map(quote).join(", ")}`);
    }
  }
  if (fixture.element && fixture.kinds.has("array")) {
    const elements = samples.filter(Array.isArray).flat();
    if (elements.length) holdFixture(fixture.element, elements, declared?.any ? declared : declared?.element, `${path}[]`, scope, oneWay, report);
    else if (fixture.element.written && fixture.element.props?.size && recorded.has("array")) report(`${path}[]`, "nothing recorded to hold this fixture against", "every recorded array here is empty");
  }
  if (!fixture.props || !fixture.kinds.has("object")) return;
  const objects = samples.filter(isObject);
  if (!objects.length) {
    if (fixture.written && fixture.props.size) report(path, "nothing recorded to hold this fixture against", `the backend sent only ${[...recorded].join(" | ")} here`);
    return;
  }
  const sent = new Set(objects.flatMap(Object.keys));
  for (const [key, prop] of fixture.props) {
    const sub = `${path}.${key}`;
    if (!scope(sub)) continue;
    if (!sent.has(key)) {
      if (!prop.optional) report(sub, "fixture key the backend never sends", "renamed on one side, or never part of this answer");
      continue;
    }
    const type = declared?.any ? declared : declared?.props?.get(key)?.shape ?? declared?.index;
    holdFixture(prop.shape, objects.filter(value => key in value).map(value => value[key]), type, sub, scope, oneWay, report);
  }
  if (oneWay || fixture.index || fixture.any || !declared?.props) return;
  for (const [key, prop] of declared.props) {
    const sub = `${path}.${key}`;
    if (prop.optional || fixture.props.has(key) || !scope(sub) || !objects.every(value => key in value)) continue;
    report(sub, "fixture lacks a key api.ts requires", "the backend always sends it");
  }
}

// ---------------------------------------------------------------------------
// Finding the fixtures.

type Site = { file: string; line: number; position: number; route: string; label: string; json?: ts.Expression; events?: Array<Record<string, unknown>>; path?: string; oneWay?: boolean };
type PathTest = { exact?: string; suffix?: string; prefix?: string; catchAll?: boolean };
type MethodTest = { method: string; equal: boolean };

const pathOfRoute = (route: string) => route.split(" ")[1]!;
const methodOfRoute = (route: string) => route.split(" ")[0]!;
const concrete = (path: string) => path.replace(/\{[^}]*\}/g, "x");
const routeRegex = (path: string) => new RegExp(`^${path.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{[^}]*\}/g, "[^/]+")}$`);
const testedPath = (test: PathTest) => (test.exact ?? test.prefix ?? test.suffix ?? "").split("?")[0]!;

function templateText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map(span => `{x}${span.literal.text}`).join("");
  return undefined;
}

const namesAPath = (node: ts.Expression) => /path|url/i.test(node.getText());

/** A route test in a condition: `pathname === "/api/…"`, `path.endsWith("/…")`, `path.startsWith("/…")`. */
function pathTest(node: ts.Expression): PathTest | undefined {
  node = unwrap(node);
  if (ts.isBinaryExpression(node)) {
    if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return pathTest(node.left) ?? pathTest(node.right);
    if (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) {
      for (const [side, other] of [[node.left, node.right], [node.right, node.left]] as const) {
        const text = templateText(other);
        if (text?.startsWith("/") && namesAPath(side)) return { exact: text };
      }
    }
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && namesAPath(node.expression.expression)) {
    const text = node.arguments[0] && templateText(node.arguments[0]);
    if (text && node.expression.name.text === "endsWith") return { suffix: text };
    if (text && node.expression.name.text === "startsWith") return { prefix: text };
  }
  return undefined;
}

/** A method test in a condition, alone or beside a route test: `request.method() === "POST"`. */
function methodTest(node: ts.Expression, alone = false): MethodTest | undefined {
  node = unwrap(node);
  if (!ts.isBinaryExpression(node)) return undefined;
  if (!alone && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return methodTest(node.left) ?? methodTest(node.right);
  const equal = node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken;
  if (!equal && node.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken) return undefined;
  const value = templateText(node.right);
  return /\bmethod\b/.test(node.left.getText()) && value ? { method: value, equal } : undefined;
}

function globTest(pattern: string): PathTest {
  const path = pattern.replace(/^\*\*/, "").replace(/\?\*\*$/, "");
  return path.includes("*") || !path.startsWith("/") ? { catchAll: true } : { exact: path };
}

/** The route test and method test that hold where a served expression stands. */
function anchor(node: ts.Node): { test?: PathTest; method?: MethodTest } {
  let test: PathTest | undefined;
  let method: MethodTest | undefined;
  for (let child: ts.Node = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isCaseClause(parent) && child !== parent.expression) {
      const text = templateText(parent.expression);
      if (text?.startsWith("/")) test ??= { exact: text };
    }
    const branch = ts.isIfStatement(parent) ? { condition: parent.expression, then: parent.thenStatement, otherwise: parent.elseStatement }
      : ts.isConditionalExpression(parent) ? { condition: parent.condition, then: parent.whenTrue, otherwise: parent.whenFalse } : undefined;
    if (branch && child === branch.then) {
      test ??= pathTest(branch.condition);
      method ??= methodTest(branch.condition);
    }
    if (branch && child === branch.otherwise) {
      const ruled = methodTest(branch.condition, true);
      if (ruled) method ??= { method: ruled.method, equal: !ruled.equal };
    }
    if (ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression) && parent.expression.name.text === "route" && child === parent.arguments[1]) {
      const pattern = parent.arguments[0] && templateText(parent.arguments[0]);
      if (pattern) test ??= globTest(pattern);
    }
    // A handler that has read the request body on its way here is answering a POST.
    if (!method && ts.isBlock(parent)) {
      const before = parent.statements.slice(0, parent.statements.indexOf(child as ts.Statement));
      if (before.some(statement => !ts.isIfStatement(statement) && /\.postData(JSON)?\(\)/.test(statement.getText()))) method = { method: "POST", equal: true };
    }
  }
  return { test, method };
}

/** The recorded route a served expression answers: a route, `undefined` for none of ours, `null` for a Memory route we do not record. */
function routeFor({ test, method }: ReturnType<typeof anchor>, routes: string[]): string | undefined | null {
  if (!test || test.catchAll) return undefined;
  const path = testedPath(test);
  let candidates = routes.filter(route => {
    const pattern = pathOfRoute(route);
    if (test.exact) return routeRegex(pattern).test(concrete(path)) || concrete(pattern) === concrete(path);
    // `endsWith("/chat")` is `/api/chat`; `endsWith("/move")` could be any move.
    if (test.suffix) return concrete(pattern) === `/api${concrete(path)}` || (path.split("/").length > 2 && concrete(pattern).endsWith(concrete(path)));
    return concrete(pattern).startsWith(concrete(path)) && concrete(pattern).length > concrete(path).length;
  });
  if (!candidates.length) return path.startsWith("/api/memory") ? null : undefined;
  if (method) candidates = candidates.filter(route => (methodOfRoute(route) === method.method) === method.equal);
  else if (candidates.some(route => methodOfRoute(route) === "GET")) candidates = candidates.filter(route => methodOfRoute(route) === "GET");
  // `startsWith("/api/memory/pages/")` is a page, not every route below it.
  if (candidates.length > 1 && test.prefix) candidates = candidates.filter(route => !concrete(pathOfRoute(route)).slice(concrete(path).length).includes("/"));
  return candidates.length === 1 ? candidates[0] : undefined;
}

function property(init: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const entry of init.properties) {
    if (ts.isPropertyAssignment(entry) && entry.name.getText() === name) return entry.initializer;
    if (ts.isShorthandPropertyAssignment(entry) && entry.name.text === name) return entry.name;
  }
  return undefined;
}

const failing = (init: ts.Node | undefined) => {
  const status = init && ts.isObjectLiteralExpression(init) ? property(init, "status") : undefined;
  return Boolean(status && ts.isNumericLiteral(status) && Number(status.text) >= 300);
};

/** Each value a served expression may be: the arms of a conditional, the sides of `??`. */
function branches(node: ts.Expression): ts.Expression[] {
  node = unwrap(node);
  if (ts.isConditionalExpression(node)) return [...branches(node.whenTrue), ...branches(node.whenFalse)];
  if (ts.isBinaryExpression(node) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)) {
    return [...branches(node.left), ...branches(node.right)];
  }
  return [node];
}

/**
 * The arms of what is served, through a constant of the fixture files that is
 * itself a choice: `json: body` where `const body = stub.pages ? … : PAGES`.
 */
function servedBranches(checker: ts.TypeChecker, node: ts.Expression, fixtures: Set<string>): ts.Expression[] {
  return branches(node).flatMap(branch => {
    const declaration = ts.isIdentifier(branch) ? checker.getSymbolAtLocation(branch)?.valueDeclaration : undefined;
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer && fixtures.has(declaration.getSourceFile().fileName)
      && ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const && branches(declaration.initializer).length > 1) {
      return servedBranches(checker, declaration.initializer, fixtures);
    }
    return [branch];
  });
}

/** A `let` the spec assigns per route and serves afterwards, as `value` in a route switch. */
function assignedLater(checker: ts.TypeChecker, node: ts.Expression): string | undefined {
  if (!ts.isIdentifier(node)) return undefined;
  const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
  return declaration && ts.isVariableDeclaration(declaration) && !(ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) ? node.text : undefined;
}

function sitesOf(file: ts.SourceFile, checker: ts.TypeChecker, fixtures: Set<string>, routes: string[], unchecked: string[], findings: Finding[]): Site[] {
  const name = basename(file.fileName);
  const found: Array<Omit<Site, "label">> = [];
  const servedLater = new Set<string>();
  const add = (node: ts.Node, value: { json?: ts.Expression; body?: ts.Expression }) => {
    const where = anchor(node);
    const route = routeFor(where, routes);
    const line = file.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    if (route === null) {
      findings.push({ id: `${name}: a fixture for ${testedPath(where.test!)}, which nothing records`, message: `${name}:${line} serves ${testedPath(where.test!)}, a Memory route the recorder does not keep; record it in record.mts and describe it in ROUTES` });
      return;
    }
    if (!route) return;
    const site = { file: name, line, position: node.getStart(), route };
    if (value.json) for (const json of servedBranches(checker, value.json, fixtures)) found.push({ ...site, json });
    else if (value.body) {
      const text = templateText(value.body);
      if (text === undefined) unchecked.push(`${name}:${line} streams ${route} from an expression the check cannot read`);
      else found.push({ ...site, events: parseSseFrames(text.endsWith("\n\n") ? text : `${text}\n\n`).events });
    }
  };
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.arguments[0]) {
      const verb = node.expression.name.text;
      if (verb === "json" && node.expression.expression.getText() === "Response" && !failing(node.arguments[1])) {
        const later = assignedLater(checker, node.arguments[0]);
        if (later) servedLater.add(later); else add(node.arguments[0], { json: node.arguments[0] });
      }
      if (verb === "fulfill") {
        for (const arg of branches(node.arguments[0])) {
          if (!ts.isObjectLiteralExpression(arg) || failing(arg)) continue;
          const json = property(arg, "json");
          const body = property(arg, "body");
          const later = json && assignedLater(checker, json);
          if (later) servedLater.add(later);
          else if (json) add(arg, { json });
          else if (body && /text\/event-stream/.test(arg.getText())) add(arg, { body });
        }
      }
    }
    if (ts.isNewExpression(node) && node.expression.getText() === "Response" && node.arguments?.[0]
      && /text\/event-stream/.test(node.arguments[1]?.getText() ?? "") && !failing(node.arguments[1])) add(node, { body: node.arguments[0] });
    ts.forEachChild(node, visit);
  };
  visit(file);
  const assignments = (node: ts.Node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left) && servedLater.has(node.left.text)) {
      add(node.right, { json: node.right });
    }
    ts.forEachChild(node, assignments);
  };
  assignments(file);
  found.sort((a, b) => a.position - b.position);
  const counts = new Map<string, number>();
  let last: Omit<Site, "label"> | undefined;
  return found.map(site => {
    // Both arms of one conditional are one site.
    if (!(last && last.position === site.position && last.route === site.route)) counts.set(site.route, (counts.get(site.route) ?? 0) + 1);
    last = site;
    return { ...site, label: `${name} (${site.route} #${counts.get(site.route)})` };
  });
}

function harnessSites(file: ts.SourceFile): Site[] {
  const name = basename(file.fileName);
  return HARNESS_FIXTURES.filter(entry => entry.file === name).map(entry => {
    let declaration: ts.VariableDeclaration | undefined;
    const visit = (node: ts.Node) => {
      if (!declaration && ts.isVariableDeclaration(node) && node.name.getText() === entry.name && node.initializer) declaration = node;
      ts.forEachChild(node, visit);
    };
    visit(file);
    if (!declaration) throw new Error(`${name} no longer declares ${entry.name}; update HARNESS_FIXTURES in shapes.mts`);
    return { file: name, line: file.getLineAndCharacterOfPosition(declaration.getStart()).line + 1, position: declaration.getStart(), route: entry.route,
      label: `${name} (${entry.name}, as ${entry.route} ${entry.path})`, json: declaration.initializer!, path: entry.path, oneWay: true };
  });
}

// ---------------------------------------------------------------------------
// The program: built once, and rebuilt cheaply when a test swaps a file's text.

const parsed = new Map<string, ts.SourceFile>();
let previous: ts.Program | undefined;

function buildProgram(overrides: Record<string, string>, routeTypes: string): ts.Program {
  const config = ts.readConfigFile(join(frontend, "tsconfig.json"), ts.sys.readFile);
  const options = { ...ts.parseJsonConfigFileContent(config.config, ts.sys, frontend).options, incremental: false, noEmit: true };
  const host = ts.createCompilerHost(options, true);
  const files: Record<string, string> = { ...overrides, [routeTypesFile]: routeTypes };
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.fileExists = fileName => fileName in files || fileExists(fileName);
  host.readFile = fileName => files[fileName] ?? readFile(fileName);
  host.getSourceFile = (fileName, language, onError, create) => {
    if (fileName in files) return ts.createSourceFile(fileName, files[fileName]!, language, true);
    let cached = parsed.get(fileName);
    if (!cached) {
      cached = getSourceFile(fileName, language, onError, create);
      if (cached) parsed.set(fileName, cached);
    }
    return cached;
  };
  previous = ts.createProgram({ rootNames: [...fixtureFiles(), routeTypesFile], options, host, oldProgram: previous });
  return previous;
}

/** The browser specs, harnesses and `*-fixture.ts` files. */
export function fixtureFiles(): string[] {
  return readdirSync(browserDir).filter(name => /\.tsx?$/.test(name) && !name.endsWith(".d.ts")).sort().map(name => join(browserDir, name));
}

// ---------------------------------------------------------------------------

export type Result = { findings: Finding[]; sites: Array<{ label: string; line: number }>; unchecked: string[] };

export function loadRecording(): Recording {
  return JSON.parse(readFileSync(fileURLToPath(new URL("./responses.json", import.meta.url)), "utf8"));
}

/**
 * Every disagreement between the recordings, the route types and the fixtures.
 * `overrides` swaps a file's text, by absolute path, and `recording` stands in
 * for `responses.json`: both are for the negative tests.
 */
export function check({ recording = loadRecording(), overrides = {} }: { recording?: Recording; overrides?: Record<string, string> } = {}): Result {
  const findings: Finding[] = [];
  const unchecked: string[] = [];
  const routes = Object.keys(ROUTES);
  const typed = routes.flatMap(route => [
    ...(ROUTES[route]!.type ? [[route, ROUTES[route]!.type!] as const] : []),
    ...Object.entries(ROUTES[route]!.events ?? {}).map(([event, type]) => [`${route} (${event})`, type] as const),
  ]);
  const program = buildProgram(overrides, `${TYPE_IMPORTS}\n${typed.map(([, type], index) => `export type Route${index} = ${type};`).join("\n")}\n`);
  const checker = program.getTypeChecker();
  const types = program.getSourceFile(routeTypesFile)!;
  const broken = [...program.getSyntacticDiagnostics(types), ...program.getSemanticDiagnostics(types)].map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
  if (broken.length) throw new Error(`The route types no longer resolve; update ROUTES or TYPE_IMPORTS in shapes.mts:\n${broken.join("\n")}`);
  const declared = new Map<string, Shape>();
  for (const statement of types.statements) {
    if (ts.isTypeAliasDeclaration(statement)) declared.set(typed[Number(statement.name.text.slice("Route".length))]![0], shapeOfType(checker, checker.getTypeFromTypeNode(statement.type)));
  }

  for (const route of routes) {
    if (!recording.routes[route]?.length) findings.push({ id: `${route}: nothing recorded`, message: `${route} is in ROUTES but responses.json holds no answer from it; run record.mts` });
  }
  for (const route of Object.keys(recording.routes)) {
    if (!ROUTES[route]) findings.push({ id: `${route}: recorded but not described`, message: `responses.json holds ${route}, which ROUTES does not describe` });
  }

  for (const [key, type] of declared) {
    const event = key.match(/ \((.+)\)$/)?.[1];
    const route = event ? key.slice(0, -event.length - 3) : key;
    const samples = recording.routes[route] ?? [];
    const values = event ? samples.flatMap(sample => sample.events ?? []).filter(item => item.type === event) : samples.map(sample => sample.json);
    holdRecorded(type, values, "$", scopeOf(ROUTES[route]!.focus), event ? ROUTES[route]!.events![event]! : ROUTES[route]!.type!,
      (path, what, detail) => findings.push({ id: `${key} ${path}: ${what}`, message: `${key} ${path}: ${what} (${detail})` }));
  }

  const fixtures = new Set(fixtureFiles());
  const sites: Site[] = [];
  for (const fileName of fixtures) {
    const file = program.getSourceFile(fileName);
    if (file) sites.push(...sitesOf(file, checker, fixtures, routes, unchecked, findings), ...harnessSites(file));
  }
  for (const site of sites) {
    const spec = ROUTES[site.route]!;
    const samples = recording.routes[site.route] ?? [];
    const report: Report = (path, what, detail) => findings.push({
      id: `${site.label} ${path}: ${what}`, message: `${site.file}:${site.line} serves ${site.route}; ${path}: ${what} (${detail})`,
    });
    if (site.events) {
      const recorded = samples.flatMap(sample => sample.events ?? []);
      for (const event of site.events) {
        const type = String(event.type);
        const same = recorded.filter(item => item.type === type);
        if (!same.length) report(`$(${type})`, "fixture event the backend never sends", `no recorded ${site.route} stream has a "${type}" event`);
        else holdFixture(fromJson(event), same, declared.get(`${site.route} (${type})`), `$(${type})`, () => true, true, report);
      }
      continue;
    }
    const target = at(samples.map(sample => sample.json), declared.get(site.route), site.path ?? "$");
    holdFixture(shapeOfExpression(checker, site.json!, fixtures), target.samples, target.shape, site.path ?? "$", scopeOf(spec.focus),
      Boolean(site.oneWay) || !spec.type, report);
  }
  const byId = new Map<string, Finding>();
  for (const finding of findings) if (!byId.has(finding.id)) byId.set(finding.id, finding);
  return {
    findings: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
    sites: sites.map(site => ({ label: site.label, line: site.line })),
    unchecked,
  };
}

/**
 * Each Memory route the frontend's own code names, its parameters as `{}`.
 * Read from string and template literals only, so a comment that mentions a
 * route is not taken for a call.
 */
export function frontendMemoryRoutes(): Array<{ path: string; at: string }> {
  const found: Array<{ path: string; at: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) {
        const file = ts.createSourceFile(full, readFileSync(full, "utf8"), ts.ScriptTarget.Latest, true);
        const visit = (node: ts.Node) => {
          const match = templateText(node)?.match(/\/api\/memory(?:\/[^?\s"'`]*)?/);
          if (match) found.push({ path: match[0].replace(/\{x\}/g, "{}").replace(/\/$/, "/{}"), at: `${relative(frontend, full)}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}` });
          if (!ts.isTemplateExpression(node)) ts.forEachChild(node, visit);
        };
        visit(file);
      }
    }
  };
  walk(join(frontend, "app"));
  return found;
}

/** A route's path with its parameters as `{}`, as `frontendMemoryRoutes` writes them. */
export const routePathKey = (route: string) => pathOfRoute(route).replace(/\{[^}]*\}/g, "{}");
