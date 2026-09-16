- **Skill registration refuses `/tmp` sources, and SKILL_CONFLICT now states an outcome.**

  A `skill-assignment` whose `metadata.source` is a process temp path
  (`/tmp`, `/var/tmp`, `os.tmpdir()`, `TMPDIR`) fails at registration with
  `skill_source_not_durable`, naming the path. Bootstrap will not list that
  path as durable provenance. Two assignments of the same skill name at the
  same priority refuse to load — the payload names both and says why — rather
  than reporting `[SKILL_CONFLICT]` and loading both. A higher priority still
  wins, and a single non-conflicting skill still loads silently.

  > **Heads-up:** `flair soul set` / `PUT /Soul` of `key=skill-assignment`
  > with a `/tmp` (or other temp) source now returns 400. Two same-name
  > assignments at equal priority load neither until one is removed or
  > given a higher priority. Refs #1433.
