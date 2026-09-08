/**
 * One JSON line per event on stderr. Stdout is reserved for the dry-run
 * report so a caller can pipe it. Nothing here ever receives a secret: callers
 * pass names, counts and statuses, never values from process.env.
 */
export function log(event: string, fields: Record<string, unknown> = {}): void {
  const line = { t: new Date().toISOString(), event, ...fields }
  process.stderr.write(JSON.stringify(line) + '\n')
}

/** A short, safe description of an error for a log line. */
export function errText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`.slice(0, 300)
  return String(e).slice(0, 300)
}
