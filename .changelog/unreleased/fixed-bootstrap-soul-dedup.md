- **`bootstrap` now de-duplicates Soul records by key before admission — the newest record per key is the one that ships.**

  A Soul table carrying stale duplicates for the same key (identity written
  repeatedly by pre-upsert writers) shipped the SAME identity body once per
  duplicate — "identity, three times" in the flair#1431 payload — with the
  structured `soul` map silently holding whichever duplicate iterated last,
  and every duplicate double-spending the soul budget against task-relevant
  recall. The NEWEST record per key (updatedAt, falling back to createdAt)
  is now the current value; older duplicates are dropped from the prose and
  the structured map alike. `skill-assignment` is exempt: multiple
  assignments per key are legitimate and still ship individually.