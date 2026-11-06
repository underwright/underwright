import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { IStore } from "./istore.js";

export type SpecKitDocType = "constitution" | "spec" | "plan" | "tasks";

export interface SpecKitTaskItem {
  id?: string;
  title: string;
  ac_ids: string[];
  done: boolean;
}

export interface ParsedSpecKitDoc {
  docType: SpecKitDocType;
  title: string;
  content: string;
  ac_ids: string[];
  tasks: SpecKitTaskItem[];
}

export interface ImportSpecKitDocInput {
  doc_type?: SpecKitDocType;
  title?: string;
  content: string;
}

export interface ImportSpecKitArgs {
  path?: string;
  task_id?: string;
  agent_id: string;
  create_tasks?: boolean;
  documents?: ImportSpecKitDocInput[];
}

const DOC_FILENAMES: Record<string, SpecKitDocType> = {
  "constitution.md": "constitution",
  "spec.md": "spec",
  "plan.md": "plan",
  "tasks.md": "tasks",
};

/** Classify a Spec Kit markdown document by its path/title or heading content. */
export function detectDocType(content: string, pathOrTitle?: string): SpecKitDocType {
  if (pathOrTitle) {
    const base = basename(pathOrTitle).toLowerCase();
    if (DOC_FILENAMES[base]) return DOC_FILENAMES[base];
    if (base.includes("constitution")) return "constitution";
    if (base.includes("tasks")) return "tasks";
    if (base.includes("plan")) return "plan";
    if (base.includes("spec")) return "spec";
  }

  const firstHeading = content.match(/^#\s+(.+)$/m)?.[1]?.toLowerCase() ?? "";
  if (firstHeading.includes("constitution")) return "constitution";
  if (firstHeading.includes("task")) return "tasks";
  if (firstHeading.includes("plan")) return "plan";
  return "spec";
}

function addId(out: Set<string>, raw: string) {
  const cleaned = raw.trim().replace(/^[`"'[\]()]+|[`"'[\](),.;:]+$/g, "");
  if (cleaned && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(cleaned)) {
    out.add(cleaned);
  }
}

function extractInlineAcTags(line: string, out: Set<string>) {
  // Matches [AC: id1, id2], (ac: id1, id2), [ac_ids: id1, id2]
  const tagRegex = /[\[(]\s*ac(?:_ids?)?\s*:\s*([^\])]+)[\])]/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRegex.exec(line)) !== null) {
    for (const part of m[1].split(/[\s,]+/)) {
      addId(out, part);
    }
  }
}

/** Extract acceptance criterion IDs from Spec Kit markdown content. */
export function extractAcIds(content: string): string[] {
  const out = new Set<string>();
  const lines = content.split(/\r?\n/);
  let inAcSection = false;

  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const hText = heading[2].toLowerCase();
      inAcSection =
        hText.includes("acceptance criteria") ||
        hText.includes("acceptance scenarios") ||
        hText.includes("success criteria") ||
        /^ac\b/.test(hText);

      // Heading like ### AC-01: Something
      const hId = heading[2].match(/^((?:AC|SC|FR)-\d+[A-Za-z0-9_-]*)\b/i);
      if (hId) addId(out, hId[1]);
      continue;
    }

    extractInlineAcTags(line, out);

    // Explicit AC/SC prefix anywhere in a bullet or bold token: - **AC-01**: ... or - [ ] AC-01: ...
    const explicitPrefix = line.match(/^\s*[-*]\s+(?:\[[ xX]\]\s+)?(?:\*\*|`)?((?:AC|SC)-\d+[A-Za-z0-9_-]*)(?:\*\*|`)?(?:\s*[:—-]\s*|\s+|$)/i);
    if (explicitPrefix) {
      addId(out, explicitPrefix[1]);
    }

    if (inAcSection) {
      // Inside an Acceptance Criteria section, extract identifiers from checklist/bullet items:
      // - [ ] speckit-import: description
      // - [ ] ac-linking
      // - `ac-id`: description
      // - **ac-id**: description
      const bullet = line.match(/^\s*[-*]\s+(?:\[[ xX]\]\s+)?(?:\*\*|`)?([A-Za-z0-9][A-Za-z0-9._-]*)(?:\*\*|`)?(?:\s*[:—-]\s+.*|\s*)$/);
      if (bullet) {
        const candidate = bullet[1];
        // Avoid treating plain English sentences like "- [ ] User can log in" as an ID when there's no colon and spaces follow,
        // Note: the regex above only matches when `candidate` is either followed by `:` / `—` / `-` + description, or is the single token on the line!
        addId(out, candidate);
      }
    }
  }

  return [...out];
}

/** Parse tasks from a Spec Kit tasks.md document. */
export function extractSpecKitTasks(content: string): SpecKitTaskItem[] {
  const tasks: SpecKitTaskItem[] = [];
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/);
    if (!m) continue;
    const done = m[1].toLowerCase() === "x";
    let rest = m[2].trim();

    const itemAcSet = new Set<string>();
    extractInlineAcTags(rest, itemAcSet);
    // Strip inline [AC: ...] / (ac: ...) tags from the title
    rest = rest.replace(/\s*[\[(]\s*ac(?:_ids?)?\s*:\s*[^\])]+[\])]/gi, "").trim();

    let id: string | undefined;
    const idMatch = rest.match(/^(?:\*\*|`)?(T\d+[A-Za-z0-9_-]*)(?:\*\*|`)?(?:\s*[:—-]?\s+)(.+)$/);
    if (idMatch) {
      id = idMatch[1];
      rest = idMatch[2].trim();
    }

    tasks.push({
      ...(id ? { id } : {}),
      title: rest,
      ac_ids: [...itemAcSet],
      done,
    });
  }
  return tasks;
}

/** Parse a single Spec Kit markdown document into its structured representation. */
export function parseSpecKitContent(content: string, pathOrTitle?: string, explicitType?: SpecKitDocType): ParsedSpecKitDoc {
  const docType = explicitType ?? detectDocType(content, pathOrTitle);
  const title = pathOrTitle || docType;
  const ac_ids = extractAcIds(content);
  const tasks = docType === "tasks" ? extractSpecKitTasks(content) : [];
  return { docType, title, content, ac_ids, tasks };
}

function collectSpecKitFiles(targetPath: string): string[] {
  if (!existsSync(targetPath)) return [];
  const st = statSync(targetPath);
  if (st.isFile()) return [targetPath];
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && DOC_FILENAMES[entry.name.toLowerCase()]) {
        found.push(full);
      }
    }
  };
  walk(targetPath);
  return found.sort();
}

/** Import Spec Kit markdown documents (constitution/spec/plan/tasks) into the store as
 *  `spec` artifacts, and link extracted `ac_ids` to `task.ac_ids` (or newly created tasks). */
export async function importSpecKit(store: IStore, args: ImportSpecKitArgs) {
  const parsedDocs: ParsedSpecKitDoc[] = [];

  if (args.path) {
    if (!existsSync(args.path)) {
      return { error: `path not found: ${args.path}` };
    }
    const files = collectSpecKitFiles(args.path);
    if (!files.length) {
      return { error: `no Spec Kit markdown files found at ${args.path}` };
    }
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      parsedDocs.push(parseSpecKitContent(content, file));
    }
  }

  for (const doc of args.documents ?? []) {
    parsedDocs.push(parseSpecKitContent(doc.content, doc.title ?? doc.doc_type, doc.doc_type));
  }

  if (!parsedDocs.length) {
    return { error: "no Spec Kit documents provided (specify path or documents)" };
  }

  if (args.task_id) {
    const existing = await store.getTask(args.task_id);
    if (!existing) return { error: `task ${args.task_id} not found` };
  }

  const artifacts: { id: string; doc_type: SpecKitDocType; title: string }[] = [];
  const allAcIds = new Set<string>();

  for (const doc of parsedDocs) {
    for (const ac of doc.ac_ids) allAcIds.add(ac);
    const art = await store.postArtifact({
      task_id: args.task_id,
      agent_id: args.agent_id,
      kind: "spec",
      title: doc.title,
      content: doc.content,
    });
    artifacts.push({ id: art.id, doc_type: doc.docType, title: doc.title });
  }

  const primarySpec = parsedDocs.find((d) => d.docType === "spec") ?? parsedDocs[0];
  const specRef = primarySpec?.title;

  let linkedTask: any = null;
  if (args.task_id) {
    const task = await store.getTask(args.task_id);
    const mergedAcs = [...new Set([...(task.ac_ids ?? []), ...allAcIds])];
    const patch: Record<string, any> = { ac_ids: mergedAcs };
    if (!task.spec_ref && specRef) patch.spec_ref = specRef;
    linkedTask = await store.updateTask(args.task_id, patch, args.agent_id);
  }

  const created_tasks: any[] = [];
  if (args.create_tasks) {
    const specLevelAcs = [...allAcIds];
    for (const doc of parsedDocs.filter((d) => d.docType === "tasks")) {
      for (const item of doc.tasks) {
        const itemAcs = item.ac_ids.length ? item.ac_ids : specLevelAcs;
        const created = await store.createTask({
          title: item.id ? `${item.id}: ${item.title}` : item.title,
          spec_ref: specRef,
          ac_ids: itemAcs,
          created_by: args.agent_id,
        });
        created_tasks.push(created);
      }
    }
  }

  return {
    artifacts,
    ac_ids: [...allAcIds],
    ...(linkedTask ? { task: linkedTask } : {}),
    ...(args.create_tasks ? { created_tasks } : {}),
  };
}
