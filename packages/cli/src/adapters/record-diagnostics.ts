/**
 * Diagnoses for requests that appear as several copies (a file copied, a session forked). A
 * diagnosis is tentative until every copy of an id has been seen, and is only kept if no copy of
 * that id ever cleared it. `resolved` — a valid (non-malformed) copy has been seen, so `malformed`
 * can never be (re-)recorded for this id. `clean` — a fully clean valid copy has been seen, so no
 * issue can be (re-)recorded for this id either.
 */
export class CopyDiagnostics<Issue extends string> {
  private readonly resolved = new Set<string>();
  private readonly clean = new Set<string>();
  private readonly malformed = new Set<string>();
  private readonly pending = new Map<Issue, Set<string>>();

  noteMalformed(id: string): void {
    if (!this.resolved.has(id)) this.malformed.add(id);
  }

  /** A valid copy of `id`, with the issues it showed (none: fully clean). */
  noteValid(id: string, issues: Issue[]): void {
    this.resolved.add(id);
    this.malformed.delete(id);
    if (issues.length === 0) {
      this.clean.add(id);
      for (const ids of this.pending.values()) ids.delete(id);
      return;
    }
    if (this.clean.has(id)) return;
    for (const issue of issues) {
      const ids = this.pending.get(issue) ?? new Set<string>();
      ids.add(id);
      this.pending.set(issue, ids);
    }
  }

  get malformedCount(): number {
    return this.malformed.size;
  }

  count(issue: Issue): number {
    return this.pending.get(issue)?.size ?? 0;
  }
}
