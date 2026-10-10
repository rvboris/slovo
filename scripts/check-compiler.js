import assert from "node:assert/strict";
import { createServer } from "vite";
import fs from "node:fs/promises";
import { parse } from "@babel/parser";
import path from "node:path";
import test from "node:test";

const JSON_INDENT = 2;
/** @typedef {{readonly filename: string, readonly kind: string, readonly name: string, readonly start: number, readonly end: number}} Candidate */
/** @type {Map<string, unknown[]>} */
const events = new Map();

/** @param {unknown} object @param {string} key @returns {unknown} */
function field(object, key) {
  if (typeof object !== "object" || object === null) {
    return false;
  }
  return Reflect.get(object, key);
}

/** @param {unknown} node @returns {Generator} */
function* nodes(node) {
  if (typeof node !== "object" || node === null) {
    return false;
  }
  yield node;
  for (const child of Object.values(node)) {
    yield* nodes(child);
  }
  return false;
}

/** @param {unknown} node @returns {boolean} */
function isFunction(node) {
  return ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(
    String(field(node, "type")),
  );
}

/** @param {unknown} node @returns {unknown} */
function unwrap(node) {
  if (isFunction(node)) {
    return node;
  }
  if (
    ["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression"].includes(
      String(field(node, "type")),
    )
  ) {
    return unwrap(field(node, "expression"));
  }
  if (field(node, "type") === "CallExpression") {
    const args = field(node, "arguments");
    if (Array.isArray(args)) {
      return unwrap(field(args, "0"));
    }
  }
  return false;
}

/** @param {string} filename @param {string} name @param {unknown} node @returns {Candidate | false} */
function candidate(filename, name, node) {
  let kind = "component";
  if (/^use[A-Z]/u.test(name)) {
    kind = "hook";
  } else if (!/^[A-Z]/u.test(name)) {
    return false;
  }
  const start = field(node, "start");
  const end = field(node, "end");
  assert.ok(
    typeof start === "number" && typeof end === "number",
    `Ambiguous React candidate ${filename}:${name}`,
  );
  return { end, filename, kind, name, start };
}

/** @param {string} filename @param {unknown} node @returns {Candidate | false} */
function identify(filename, node) {
  const name = field(field(node, "id"), "name");
  if (typeof name !== "string") {
    return false;
  }
  if (field(node, "type") === "FunctionDeclaration") {
    return candidate(filename, name, node);
  }
  if (field(node, "type") === "VariableDeclarator") {
    const callable = unwrap(field(node, "init"));
    if (callable !== false) {
      return candidate(filename, name, callable);
    }
  }
  return false;
}

/** @param {string} filename @param {string} source @returns {Candidate[]} */
function inventory(filename, source) {
  const candidates = [];
  const ast = parse(source, { plugins: ["typescript", "jsx"], sourceType: "module" });
  for (const node of nodes(ast)) {
    assert.notEqual(field(node, "value"), "use no memo", `Compiler opt-out in ${filename}`);
    const found = identify(filename, node);
    if (found !== false) {
      candidates.push(found);
    }
  }
  return candidates;
}

/** @param {string} filename @param {unknown} event */
function logEvent(filename, event) {
  const normalized = path.resolve(filename);
  const recorded = events.get(normalized) ?? [];
  recorded.push(event);
  events.set(normalized, recorded);
}

/** @param {unknown} options */
function reactBabel(options) {
  const plugins = field(options, "plugins");
  assert.ok(Array.isArray(plugins), "Missing Babel plugin configuration");
  for (const plugin of plugins) {
    const name = field(plugin, "0");
    const settings = field(plugin, "1");
    if (name === "babel-plugin-react-compiler") {
      assert.ok(typeof settings === "object" && settings !== null);
      Reflect.set(settings, "logger", { logEvent });
    }
  }
}

/** @param {Candidate} item @returns {boolean} */
function compiled(item) {
  return (events.get(item.filename) ?? []).some((event) => {
    const location = field(event, "fnLoc");
    return (
      field(event, "kind") === "CompileSuccess" &&
      field(field(location, "start"), "index") === item.start &&
      field(field(location, "end"), "index") === item.end
    );
  });
}

/** @param {readonly Candidate[]} candidates */
function verify(candidates) {
  const missing = candidates.filter((item) => !compiled(item));
  process.stdout.write(
    `${JSON.stringify({ candidates, events: [...events], missing }, undefined, JSON_INDENT)}\n`,
  );
  assert.notDeepEqual(candidates, [], "No authored React functions discovered");
  assert.deepEqual(
    missing,
    [],
    "Authored functions were skipped or unseen by the configured compiler",
  );
}

void test("all authored React components and hooks compile through configured Vite", async () => {
  const server = await createServer({
    optimizeDeps: { include: [], noDiscovery: true },
    plugins: [{ api: { reactBabel }, name: "compiler-coverage" }],
    server: { hmr: false, middlewareMode: true, watch: { ignored: ["**/*"] } },
  });
  try {
    const entries = await fs.readdir("src", { recursive: true });
    const files = entries.filter((filename) => /\.tsx?$/u.test(filename));
    const results = await Promise.all(
      files.map(async (filename) => {
        const absolute = path.resolve("src", filename);
        const source = await fs.readFile(absolute, "utf8");
        const candidates = inventory(absolute, source);
        await server.transformRequest(`/src/${filename}`);
        return candidates;
      }),
    );
    verify(results.flat());
  } finally {
    await server.close();
  }
});
