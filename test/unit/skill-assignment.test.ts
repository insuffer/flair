/**
 * skill-assignment.test.ts — flair#1433 provenance + SKILL_CONFLICT.
 *
 * Fails-first: `mainlineFormatActiveSkills` is today's MemoryBootstrap
 * behaviour (accept /tmp, flag same-priority peers, load both). The chip
 * assertions fail against that helper and pass against the shipped module.
 *
 * Negative control: a normally-installed, non-conflicting skill still loads
 * silently. A registration path that rejects valid skills gets bypassed.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SKILL_ASSIGNMENT_KEY,
  formatActiveSkillLines,
  isNonDurableSkillSource,
  refuseNonDurableSkillSource,
  resolveActiveSkills,
} from "../../resources/skill-assignment.ts";

const TMP_INSPECT =
  "/tmp/harperfast-skills-inspect/package/harper-best-practices/SKILL.md";
const NPM_SOURCE = "npm:@harperfast/skills@1.4.2@1.4.2";
const DURABLE_PATH = "/home/agent/.flair/skills/harper-best-practices/SKILL.md";

function assignment(opts: {
  value: string;
  priority?: string;
  source?: string;
  id?: string;
  metadata?: unknown;
}) {
  const metadata =
    opts.metadata !== undefined
      ? opts.metadata
      : opts.source
        ? JSON.stringify({ source: opts.source })
        : undefined;
  return {
    id: opts.id ?? `${opts.value}:${opts.source ?? "none"}`,
    key: SKILL_ASSIGNMENT_KEY,
    value: opts.value,
    priority: opts.priority,
    metadata,
  };
}

/**
 * Exact pre-#1433 MemoryBootstrap formatter (resources/MemoryBootstrap.ts
 * on origin/main). Known-answer: the live flint payload's shape.
 */
function mainlineFormatActiveSkills(assignments: any[]): string[] {
  const priorityOrder: Record<string, number> = { critical: 0, high: 1, standard: 2, low: 3 };
  const sorted = [...assignments].sort((a, b) => {
    const pa = priorityOrder[a.priority ?? "standard"] ?? 2;
    const pb = priorityOrder[b.priority ?? "standard"] ?? 2;
    return pa - pb;
  });
  const byPriority = new Map<string, any[]>();
  for (const skill of sorted) {
    const p = skill.priority ?? "standard";
    if (!byPriority.has(p)) byPriority.set(p, []);
    byPriority.get(p)!.push(skill);
  }
  const lines: string[] = [];
  for (const skill of sorted) {
    const p = skill.priority ?? "standard";
    let meta: any = {};
    try {
      meta = typeof skill.metadata === "string" ? JSON.parse(skill.metadata) : (skill.metadata ?? {});
    } catch {
      /* ignore */
    }
    const source = meta.source ? `, source: ${meta.source}` : "";
    let line = `- ${skill.value} (${p} priority${source})`;
    const peers = byPriority.get(p) ?? [];
    if (peers.length > 1) line += " [SKILL_CONFLICT]";
    lines.push(line);
  }
  return lines;
}

describe("known-answer: mainline accepts /tmp and loads both (the bug)", () => {
  test("the observed flint payload is accepted and both rows load", () => {
    const rows = [
      assignment({
        value: "harper-best-practices",
        priority: "standard",
        source: TMP_INSPECT,
      }),
      assignment({
        value: "harperfast-skills",
        priority: "standard",
        source: NPM_SOURCE,
      }),
    ];
    const lines = mainlineFormatActiveSkills(rows);
    expect(lines).toEqual([
      `- harper-best-practices (standard priority, source: ${TMP_INSPECT}) [SKILL_CONFLICT]`,
      `- harperfast-skills (standard priority, source: ${NPM_SOURCE}) [SKILL_CONFLICT]`,
    ]);
    expect(refuseNonDurableSkillSource(rows[0])).not.toBeNull();
    expect(mainlineFormatActiveSkills(rows).every((line) => !line.includes("refused"))).toBe(true);
  });
});

describe("defect 1 — refuse non-durable sources at registration", () => {
  test("register from /tmp fails and names the path", async () => {
    const content = assignment({ value: "harper-best-practices", source: TMP_INSPECT });
    const res = refuseNonDurableSkillSource(content);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    const body = await res!.json();
    expect(body.error).toBe("skill_source_not_durable");
    expect(body.path).toBe(TMP_INSPECT);
    expect(body.message).toContain(TMP_INSPECT);
  });

  test("/var/tmp, /private/tmp, file: URL, and os.tmpdir() also fail", async () => {
    const paths = [
      "/var/tmp/skills-inspect/SKILL.md",
      "/private/tmp/skills-inspect/SKILL.md",
      `file://${TMP_INSPECT}`,
      path.join(tmpdir(), "skills-inspect", "SKILL.md"),
    ];
    for (const source of paths) {
      const res = refuseNonDurableSkillSource(assignment({ value: "scratch", source }));
      expect(res, source).not.toBeNull();
      const body = await res!.json();
      expect(body.path).toBe(source);
      expect(body.message).toContain(source);
    }
  });

  test("TMPDIR from the env is treated as a scratch root", async () => {
    const env = { TMPDIR: "/scratch-box" };
    const source = "/scratch-box/inspect/SKILL.md";
    expect(isNonDurableSkillSource(source, env)).toBe(true);
    const res = refuseNonDurableSkillSource(assignment({ value: "x", source }), env);
    expect(res).not.toBeNull();
    expect((await res!.json()).path).toBe(source);
  });

  test("/tmpfoo is not /tmp (prefix must be a path component)", () => {
    expect(isNonDurableSkillSource("/tmpfoo/SKILL.md")).toBe(false);
    expect(refuseNonDurableSkillSource(assignment({ value: "x", source: "/tmpfoo/SKILL.md" }))).toBeNull();
  });

  test("npm: and a durable filesystem path still register", () => {
    expect(refuseNonDurableSkillSource(assignment({ value: "harperfast-skills", source: NPM_SOURCE }))).toBeNull();
    expect(refuseNonDurableSkillSource(assignment({ value: "harper-best-practices", source: DURABLE_PATH }))).toBeNull();
  });

  test("a Soul write that is not a skill-assignment is a no-op", () => {
    expect(
      refuseNonDurableSkillSource({
        key: "role",
        value: "builder",
        metadata: JSON.stringify({ source: TMP_INSPECT }),
      }),
    ).toBeNull();
  });

  test("a skill-assignment with no source still registers (nothing to refuse)", () => {
    expect(refuseNonDurableSkillSource(assignment({ value: "local-sop" }))).toBeNull();
  });
});

describe("defect 2 — SKILL_CONFLICT determines an outcome", () => {
  test("two equal-priority same-name skills refuse; payload names both and why", () => {
    const rows = [
      assignment({ value: "harper-best-practices", priority: "standard", source: NPM_SOURCE, id: "b" }),
      assignment({ value: "harper-best-practices", priority: "standard", source: DURABLE_PATH, id: "a" }),
    ];
    const outcomes = resolveActiveSkills(rows);
    expect(outcomes.every((o) => o.loaded === false)).toBe(true);
    expect(outcomes.every((o) => o.marker === "SKILL_CONFLICT")).toBe(true);
    for (const o of outcomes) {
      expect(o.reason).toMatch(/refused: equal-priority conflict/);
      expect(o.reason).toMatch(/will not pick by map order/);
    }
    const lines = formatActiveSkillLines(rows);
    expect(lines.some((line) => line.includes(NPM_SOURCE))).toBe(true);
    expect(lines.some((line) => line.includes(DURABLE_PATH))).toBe(true);
    expect(lines.every((line) => line.includes("[SKILL_CONFLICT]"))).toBe(true);
    expect(lines.every((line) => !line.includes("loaded anyway"))).toBe(true);
  });

  test("same pair in reverse insertion order states the same outcome", () => {
    const a = assignment({ value: "dup", priority: "standard", source: NPM_SOURCE, id: "z-last" });
    const b = assignment({ value: "dup", priority: "standard", source: DURABLE_PATH, id: "a-first" });
    const forward = formatActiveSkillLines([a, b]);
    const reverse = formatActiveSkillLines([b, a]);
    expect(reverse).toEqual(forward);
    const again = formatActiveSkillLines([b, a]);
    expect(again).toEqual(forward);
  });

  test("same name at different priorities: higher priority wins and the payload says why", () => {
    const rows = [
      assignment({ value: "harper-best-practices", priority: "standard", source: DURABLE_PATH, id: "low" }),
      assignment({ value: "harper-best-practices", priority: "critical", source: NPM_SOURCE, id: "high" }),
    ];
    const outcomes = resolveActiveSkills(rows);
    const loaded = outcomes.filter((o) => o.loaded);
    const resolved = outcomes.filter((o) => !o.loaded);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].source).toBe(NPM_SOURCE);
    expect(loaded[0].marker).toBeUndefined();
    expect(resolved).toHaveLength(1);
    expect(resolved[0].marker).toBe("SKILL_CONFLICT");
    expect(resolved[0].reason).toBe(
      "resolved: harper-best-practices wins by priority (critical > standard)",
    );
  });

  test("the observed /tmp + npm pair: /tmp is refused, npm loads, no report-and-load-both", () => {
    const rows = [
      assignment({
        value: "harper-best-practices",
        priority: "standard",
        source: TMP_INSPECT,
      }),
      assignment({
        value: "harperfast-skills",
        priority: "standard",
        source: NPM_SOURCE,
      }),
    ];
    const outcomes = resolveActiveSkills(rows);
    const loaded = outcomes.filter((o) => o.loaded);
    const refused = outcomes.filter((o) => !o.loaded);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe("harperfast-skills");
    expect(loaded[0].marker).toBeUndefined();
    expect(refused).toHaveLength(1);
    expect(refused[0].marker).toBe("SKILL_SOURCE_NOT_DURABLE");
    expect(refused[0].reason).toContain(TMP_INSPECT);
    const lines = formatActiveSkillLines(rows);
    expect(lines.join("\n")).not.toBe(mainlineFormatActiveSkills(rows).join("\n"));
  });
});

describe("negative control — a normal non-conflicting skill loads silently", () => {
  test("one durable skill has no marker and no reason", () => {
    const rows = [assignment({ value: "local-sop", priority: "standard", source: NPM_SOURCE })];
    const outcomes = resolveActiveSkills(rows);
    expect(outcomes).toEqual([
      {
        name: "local-sop",
        priority: "standard",
        source: NPM_SOURCE,
        id: `local-sop:${NPM_SOURCE}`,
        loaded: true,
      },
    ]);
    expect(formatActiveSkillLines(rows)).toEqual([
      `- local-sop (standard priority, source: ${NPM_SOURCE})`,
    ]);
  });

  test("two different names at standard both load — they are not a conflict", () => {
    const rows = [
      assignment({ value: "local-sop", priority: "standard", source: DURABLE_PATH }),
      assignment({ value: "harperfast-skills", priority: "standard", source: NPM_SOURCE }),
    ];
    const outcomes = resolveActiveSkills(rows);
    expect(outcomes.every((o) => o.loaded)).toBe(true);
    expect(outcomes.every((o) => o.marker === undefined)).toBe(true);
    expect(formatActiveSkillLines(rows).every((line) => !line.includes("[SKILL_CONFLICT]"))).toBe(true);
  });
});

describe("wiring tripwires", () => {
  test("Soul post/put/patch call the registration gate", () => {
    const source = readFileSync("resources/Soul.ts", "utf8");
    expect(source).toMatch(/refuseNonDurableSkillSource/);
    expect(source.match(/refuseNonDurableSkillSource\(/g)?.length).toBeGreaterThanOrEqual(3);
  });

  test("MemoryBootstrap uses the resolver, not flag-and-load-both", () => {
    const source = readFileSync("resources/MemoryBootstrap.ts", "utf8");
    expect(source).toMatch(/formatActiveSkillLines/);
    expect(source).not.toMatch(/line \+= " \[SKILL_CONFLICT\]"/);
  });
});
