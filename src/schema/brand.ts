/**
 * The brand-accuracy check results (src/pipeline/42-brand.ts) as the sealed
 * run summary carries them and the protocol report reads them. Shapes only,
 * here so the protocol never imports the pipeline. No answer text: only
 * pass or fail, and which of the check's own phrases failed.
 */

/** One answer against one check: the must_not phrases it used and the must phrases it left out. */
export interface BrandJudgement { pass: boolean; must_not: string[]; must: string[] }

/** One check's result: each packet engine that answered, pass or fail, and which phrases. */
export interface BrandCheckResult {
  question: string
  /** True when at least one engine answered and every one that did passed; null when none answered. */
  pass: boolean | null
  engines: Array<{ engine: string } & BrandJudgement>
}

/** One subject's brand checks in the summary: counts, and each check by engine. */
export interface BrandSummary {
  checks: number
  /** Checks with at least one answer, and of those the ones every answering engine passed. */
  answered: number
  passed: number
  answers: number
  skipped_cap: number
  results: BrandCheckResult[]
}
