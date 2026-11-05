// AST/symbol-level code index (tree-sitter, WASM). Name-based: definitions and
// references are matched by identifier, not resolved through the type system, so
// blast radius is a deliberately conservative over-approximation.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

const require = createRequire(import.meta.url);
// web-tree-sitter ships CJS; load via require to avoid ESM/CJS interop surprises.
const TS: any = require("web-tree-sitter");

export interface SymbolRec { name: string; kind: string; line: number; end_line: number; exported: boolean }
export interface RefRec { name: string; line: number; container: string }
export interface FileIndex { symbols: SymbolRec[]; refs: RefRec[] }

/** The slice of the store the indexer needs (sync — SQLite). */
export interface CodeIndexSink {
  codeFileHashes(): Record<string, string>;
  upsertCodeFile(path: string, hash: string, symbols: SymbolRec[], refs: RefRec[], actor: string): void;
  removeCodeFile(path: string, actor: string): void;
}

const GRAMMARS: Record<string, string> = {
  ".ts": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascript",
};
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "build", "coverage"]);

let initP: Promise<void> | null = null;
const langs = new Map<string, any>();

async function language(name: string) {
  initP ??= TS.Parser.init();
  await initP;
  let l = langs.get(name);
  if (!l) {
    l = await TS.Language.load(require.resolve(`tree-sitter-wasms/out/tree-sitter-${name}.wasm`));
    langs.set(name, l);
  }
  return l;
}

export const isIndexable = (p: string) => extname(p) in GRAMMARS && !p.endsWith(".d.ts");

const DECL_KINDS: Record<string, string> = {
  function_declaration: "function", generator_function_declaration: "function",
  class_declaration: "class", abstract_class_declaration: "class",
  interface_declaration: "interface", type_alias_declaration: "type", enum_declaration: "enum",
  method_definition: "method", abstract_method_signature: "method", method_signature: "method",
};

/** Parse one source file into symbol definitions and name references. */
export async function extractFile(source: string, path: string): Promise<FileIndex> {
  const lang = await language(GRAMMARS[extname(path)] ?? "typescript");
  const parser = new TS.Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(source);
  const symbols: SymbolRec[] = [];
  const refs: RefRec[] = [];

  const add = (n: any, name: string, kind: string, exported: boolean) =>
    symbols.push({ name, kind, line: n.startPosition.row + 1, end_line: n.endPosition.row + 1, exported });
  const ref = (n: any, container: string) =>
    refs.push({ name: n.text, line: n.startPosition.row + 1, container });

  const walk = (n: any, container: string, exported: boolean) => {
    let nextContainer = container;
    let nextExported = exported;
    switch (n.type) {
      case "export_statement": nextExported = true; break;
      case "variable_declarator": {
        const id = n.childForFieldName("name");
        if (id?.type === "identifier") {
          const v = n.childForFieldName("value");
          const isFn = v && (v.type === "arrow_function" || v.type === "function_expression" || v.type === "function");
          add(n, id.text, isFn ? "function" : "variable", exported);
          // only function-valued consts own their body; plain consts' initializers belong to the outer scope
          if (isFn) nextContainer = id.text;
        }
        break;
      }
      case "call_expression": {
        const f = n.childForFieldName("function");
        if (f?.type === "identifier") ref(f, container);
        else if (f?.type === "member_expression") {
          const prop = f.childForFieldName("property");
          if (prop) ref(prop, container);
        }
        break;
      }
      case "new_expression": {
        const c = n.childForFieldName("constructor");
        if (c?.type === "identifier") ref(c, container);
        break;
      }
      case "type_identifier": ref(n, container); break;
      case "import_specifier": {
        const nm = n.childForFieldName("name");
        if (nm) ref(nm, container);
        break;
      }
      default:
        if (DECL_KINDS[n.type]) {
          const id = n.childForFieldName("name");
          if (id) {
            add(n, id.text, DECL_KINDS[n.type], exported);
            nextContainer = id.text;
          }
        }
    }
    // exported-ness applies only to the declaration directly under `export`, not its body
    const childExported = n.type === "export_statement" || n.type === "lexical_declaration" ? nextExported : false;
    for (const c of n.namedChildren) walk(c, nextContainer, childExported);
  };
  walk(tree.rootNode, "", false);
  tree.delete();
  parser.delete();
  return { symbols, refs };
}

function* walkFiles(root: string, dir = root): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) yield* walkFiles(root, join(dir, e.name));
    } else if (e.isFile() && isIndexable(e.name) && statSync(join(dir, e.name)).size < 1_000_000) {
      yield join(dir, e.name);
    }
  }
}

/** Incrementally (re)index `root`: parse only files whose content hash changed; drop deleted files. */
export async function indexWorkspace(sink: CodeIndexSink, root: string, actor = "indexer") {
  const known = sink.codeFileHashes();
  const seen = new Set<string>();
  let indexed = 0, unchanged = 0, removed = 0;
  for (const abs of walkFiles(root)) {
    const rel = relative(root, abs).split(sep).join("/");
    seen.add(rel);
    const src = readFileSync(abs, "utf8");
    const hash = createHash("sha256").update(src).digest("hex");
    if (known[rel] === hash) { unchanged++; continue; }
    const { symbols, refs } = await extractFile(src, rel);
    sink.upsertCodeFile(rel, hash, symbols, refs, actor);
    indexed++;
  }
  for (const p of Object.keys(known)) {
    if (!seen.has(p)) { sink.removeCodeFile(p, actor); removed++; }
  }
  return { indexed, unchanged, removed, files: seen.size };
}
