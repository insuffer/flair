/**
 * skill-assignment.ts — provenance + precedence for Soul `skill-assignment`
 * rows (flair#1433).
 *
 * Active Skills in bootstrap are Soul records with key `skill-assignment`.
 * `value` is the skill name, `priority` is the governance tier, and
 * `metadata.source` is the recorded provenance. This module is Harper-free
 * so unit tests can drive the real shipped rules (same reason as
 * skill-write.ts / memory-bootstrap-lib.ts).
 *
 * Two rules, and nothing else (trust / signature is a later epic slice):
 *
 *   1. A filesystem path under a process temp root (`/tmp`, `/var/tmp`,
 *      `os.tmpdir()`, TMPDIR/TEMP/TMP, …) is not durable provenance.
 *      Registration (Soul post/put/patch) fails naming the path. Load
 *      refuses the same path so an already-recorded scratch source cannot
 *      keep appearing as an Active Skill.
 *
 *   2. SKILL_CONFLICT must determine an outcome. Conflict is same skill
 *      *identity* (`value`) — two different names at `standard` both load.
 *      Same name, different priority: the higher priority loads and the
 *      payload says why. Same name, equal top priority: refuse the group
 *      (do not pick by map iteration order); the payload names the peers
 *      and the rule.
 */

import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Soul.key that bootstrap treats as an Active Skill assignment. */
export const SKILL_ASSIGNMENT_KEY = "skill-assignment";

export const SKILL_PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  standard: 2,
  low: 3,
};

/** Well-known POSIX scratch roots. `/private/tmp` is macOS `/tmp` after resolve. */
const POSIX_TEMP_ROOTS = [
  "/tmp",
  "/var/tmp",
  "/private/tmp",
  "/dev/shm",
  "/var/folders",
  "/private/var/folders",
];

export type ActiveSkillOutcome = {
  name: string;
  priority: string;
  source?: string;
  id: string;
  loaded: boolean;
  marker?: "SKILL_CONFLICT" | "SKILL_SOURCE_NOT_DURABLE";
  reason?: string;
};

function parseMetadata(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === "string" && raw.length > 0) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* opaque / corrupt metadata → no source */
    }
  }
  return {};
}

/** `metadata.source` as bootstrap already reads it (string or JSON blob). */
export function skillAssignmentSource(record: { metadata?: unknown } | null | undefined): string | undefined {
  const source = parseMetadata(record?.metadata).source;
  return typeof source === "string" && source.length > 0 ? source : undefined;
}

export function skillName(record: { value?: unknown } | null | undefined): string {
  return typeof record?.value === "string" ? record.value : "";
}

export function skillPriority(record: { priority?: unknown } | null | undefined): string {
  const p = record?.priority;
  return typeof p === "string" && p.length > 0 ? p : "standard";
}

function assignmentId(record: { id?: unknown } | null | undefined): string {
  return typeof record?.id === "string" ? record.id : "";
}

/**
 * Absolute filesystem path encoded in a source string. `npm:`, `https:`,
 * and other URI schemes are not filesystem scratch and return null.
 */
export function filesystemPathFromSource(source: string): string | null {
  if (source.startsWith("file:")) {
    try {
      return fileURLToPath(source);
    } catch {
      return null;
    }
  }
  if (source.startsWith("/") || /^[A-Za-z]:[\\/]/.test(source)) return source;
  return null;
}

function isPathInside(candidate: string, root: string): boolean {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  if (resolvedCandidate === resolvedRoot) return true;
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  return resolvedCandidate.startsWith(prefix);
}

/** Temp roots the process does not control — POSIX scratch + env/os tmpdir. */
export function collectTempRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = [...POSIX_TEMP_ROOTS];
  for (const extra of [tmpdir(), env.TMPDIR, env.TEMP, env.TMP]) {
    if (typeof extra === "string" && extra.length > 0 && filesystemPathFromSource(extra)) {
      roots.push(extra);
    }
  }
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

export function isNonDurableSkillSource(source: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const fsPath = filesystemPathFromSource(source);
  if (!fsPath) return false;
  return collectTempRoots(env).some((root) => isPathInside(fsPath, root));
}

/**
 * Registration gate. A `skill-assignment` Soul write whose metadata.source
 * is a temp path fails with 400, naming the path. Other Soul keys are a no-op.
 */
export function refuseNonDurableSkillSource(
  content: { key?: unknown; metadata?: unknown } | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Response | null {
  if (content?.key !== SKILL_ASSIGNMENT_KEY) return null;
  const source = skillAssignmentSource(content);
  if (!source || !isNonDurableSkillSource(source, env)) return null;
  return new Response(
    JSON.stringify({
      error: "skill_source_not_durable",
      path: source,
      message: `skill source is not durable: ${source}`,
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

function compareAssignments(
  a: { name: string; priority: string; source?: string; id: string },
  b: { name: string; priority: string; source?: string; id: string },
): number {
  const pa = SKILL_PRIORITY_ORDER[a.priority] ?? 2;
  const pb = SKILL_PRIORITY_ORDER[b.priority] ?? 2;
  if (pa !== pb) return pa - pb;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  const sa = a.source ?? "";
  const sb = b.source ?? "";
  if (sa !== sb) return sa < sb ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

function describePeer(row: { name: string; source?: string }): string {
  return row.source ? `${row.name} (source: ${row.source})` : row.name;
}

/**
 * Load-time resolution. Outcome is a function of (name, priority, source, id)
 * only — never Map insertion order — so a restart with the same rows states
 * the same winner or the same refusal.
 */
export function resolveActiveSkills(assignments: any[]): ActiveSkillOutcome[] {
  const parsed = assignments.map((record) => ({
    name: skillName(record),
    priority: skillPriority(record),
    source: skillAssignmentSource(record),
    id: assignmentId(record),
  }));

  const outcomes: ActiveSkillOutcome[] = [];
  const durable: typeof parsed = [];

  for (const row of parsed) {
    if (row.source && isNonDurableSkillSource(row.source)) {
      outcomes.push({
        ...row,
        loaded: false,
        marker: "SKILL_SOURCE_NOT_DURABLE",
        reason: `refused: non-durable source ${row.source}`,
      });
    } else {
      durable.push(row);
    }
  }

  const byName = new Map<string, typeof durable>();
  for (const row of durable) {
    const list = byName.get(row.name) ?? [];
    list.push(row);
    byName.set(row.name, list);
  }

  const names = [...byName.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const name of names) {
    const group = byName.get(name)!;
    if (group.length === 1) {
      outcomes.push({ ...group[0], loaded: true });
      continue;
    }

    let topRank = Infinity;
    for (const row of group) {
      const rank = SKILL_PRIORITY_ORDER[row.priority] ?? 2;
      if (rank < topRank) topRank = rank;
    }
    const top = group.filter((row) => (SKILL_PRIORITY_ORDER[row.priority] ?? 2) === topRank);
    const rest = group.filter((row) => (SKILL_PRIORITY_ORDER[row.priority] ?? 2) !== topRank);

    if (top.length === 1) {
      const winner = top[0];
      outcomes.push({ ...winner, loaded: true });
      for (const loser of rest) {
        outcomes.push({
          ...loser,
          loaded: false,
          marker: "SKILL_CONFLICT",
          reason: `resolved: ${winner.name} wins by priority (${winner.priority} > ${loser.priority})`,
        });
      }
      continue;
    }

    const peers = [...group].sort(compareAssignments);
    for (const row of group) {
      const others = peers.filter((peer) => peer !== row).map(describePeer).join(", ");
      outcomes.push({
        ...row,
        loaded: false,
        marker: "SKILL_CONFLICT",
        reason: `refused: equal-priority conflict with ${others}; will not pick by map order`,
      });
    }
  }

  outcomes.sort((a, b) => {
    const loadedDelta = Number(b.loaded) - Number(a.loaded);
    if (loadedDelta !== 0) return loadedDelta;
    return compareAssignments(a, b);
  });
  return outcomes;
}

export function formatActiveSkillLine(outcome: ActiveSkillOutcome): string {
  const source = outcome.source ? `, source: ${outcome.source}` : "";
  let line = `- ${outcome.name} (${outcome.priority} priority${source})`;
  if (outcome.marker) line += ` [${outcome.marker}]`;
  if (outcome.reason) line += ` ${outcome.reason}`;
  return line;
}

export function formatActiveSkillLines(assignments: any[]): string[] {
  return resolveActiveSkills(assignments).map(formatActiveSkillLine);
}
