/**
 * The diagnosis and win-kit shapes the protocol reads from the sealed run
 * summary, and the kit as the packet carries it once Control Center lists the
 * `kits` packet feature. They live here, not in src/pipeline/, so the
 * protocol code (the daily directive's path) never imports the pipeline, not
 * even for a type: the cost wall (tests/protocol.test.ts) holds it to that.
 *
 * Also here: which of Krish's decisions open, stop and close a kit plan
 * (GET-GOING Step 1). The research job reads them to give a kit in flight
 * its panel tier, and the report job to propose its check-ins, so both read
 * one rule.
 */
import { canonicalJson, sha256Hex } from '../lib/canonical.js'
import type { SourceType } from '../lib/sourceType.js'

/** Why a question is not won (src/pipeline/52-diagnose.ts), checked in this order. */
export const GAP_CLASSES = ['won', 'cited_not_first', 'retrieved_not_cited', 'not_retrieved', 'no_page', 'unknown'] as const
export type GapClass = (typeof GAP_CLASSES)[number]

/** What a kit asks to be done: update a page of ours, write a new one, or be present off site only. */
export const TARGET_KINDS = ['new_page', 'update_page', 'off_site_only'] as const
export type TargetKind = (typeof TARGET_KINDS)[number]

/** The site audit's host gates (src/pipeline/15-site.ts), each a pass or a fail per host. */
export const HOST_GATES = ['search_bots_allowed', 'user_bots_allowed', 'homepage_200', 'homepage_server_rendered', 'homepage_single_h1', 'sitemap_present'] as const
export type HostGate = (typeof HOST_GATES)[number]

/** What one page cited first does, read fetch only (src/pipeline/45-pages.ts). */
export interface CitedFeatures {
  /** Null when the cited URL carries an email or a handle: the host and type are kept, the URL is not. */
  url: string | null
  host: string
  source_type: SourceType
  /** Whether the page was read. When false, every feature below is null. */
  read: boolean
  /** Half or more of the question's words are in the page's title. */
  title_matches_question: boolean | null
  /** Words in the first paragraph under its H1. */
  answer_first_words: number | null
  words: number | null
  h2_count: number | null
  dated: boolean | null
  server_rendered: boolean | null
}

export interface KitTarget { kind: TargetKind; url: string | null; host: string; suggested_path: string | null }
export interface KitSiteFix { gate: string; host: string; url: string | null; fix: string; owner_repo: string | null }
/** `url` is null when the page cited first cannot be carried (an email or a handle in it): its host stands for it. */
export interface KitBeat { url: string | null; host: string; engine: string; position: number; features: CitedFeatures }
export interface KitOffSite { host: string; source_type: SourceType; engines: string[] }

/** A win kit (src/pipeline/62-kits.ts), the shape the packet's `kits[]` carries. */
export interface Kit {
  kit_id: string
  v: 1
  product_slug: string
  query_id: string
  question: string
  gap_class: GapClass
  priority: number
  /** General platforms own the first citation (the diagnosis): why an off-site kit is off site. */
  owned_by_platform: boolean
  target: KitTarget
  /** The question in the buyer's words, at most 70 characters. */
  title: string
  capsule: { rules: string[]; must_cover: null }
  h2s: string[]
  beat: KitBeat[]
  site_fixes: KitSiteFix[]
  off_site: KitOffSite[]
  verify: { engines: string[]; samples: 3; success: string; recheck: string; baseline: GapClass }
  evidence: string[]
}

/** What one subject's top kit carries into the sealed run summary (src/pipeline/62-kits.ts, kitCandidate). */
export interface KitCandidate {
  product_slug: string
  query_id: string
  priority: number
  title: string
  /** The kit rendered as plain text for Krish, at most 8000 characters. */
  exact_payload: string
  gap_class: GapClass
  target_kind: TargetKind
  /** The target page's URL, else its host: the close condition's reference. */
  reference: string
}

/** The site reader's counts for one subject. */
export interface SiteCounts { hosts: number; pages: number; requests: number; errors: number; gates_failed: number; cited_read: number }

/**
 * What the diagnosis found for one subject, for the sealed summary: counts of
 * each gap class, the site reader's counts, how many kits were prepared, and
 * the top kit. Never in the packet or a log.
 */
export interface SubjectDiagnosis {
  gap_classes: Record<GapClass, number>
  kits: number
  held: boolean
  kit_candidate: KitCandidate | null
  /**
   * The next kits after the top one, in priority order, at most two. The
   * research report reads them only when Krish has already decided the top
   * one, so a kit he declined (or approved) never comes back as a fresh ask.
   */
  kit_backups: KitCandidate[]
  site: SiteCounts | null
}

/** How many kits after the top one a subject's sealed summary carries. */
export const KIT_BACKUPS_MAX = 2

// ---------- kit plans: Krish's decisions on them ----------

/** A win kit's plan id: aeo:kit:<product_slug>:<first 8 of query_id>, stable across runs for one question. */
export const KIT_PROPOSAL_PREFIX = 'aeo:kit:'
/** A check-in on a kit plan: aeo:checkin:<product_slug>:<first 8 of query_id>, one per plan, kept current. */
export const CHECKIN_PREFIX = 'aeo:checkin:'
export const kitProposalId = (productSlug: string, queryId: string) => `${KIT_PROPOSAL_PREFIX}${productSlug}:${queryId.slice(0, 8)}`
export const checkInId = (planId: string) => `${CHECKIN_PREFIX}${planId.slice(KIT_PROPOSAL_PREFIX.length)}`
export const planIdOfCheckIn = (checkInProposalId: string) => `${KIT_PROPOSAL_PREFIX}${checkInProposalId.slice(CHECKIN_PREFIX.length)}`

/**
 * How long an approved kit plan is checked in on (AGENTS.md: a check-in after
 * every research run while a plan is open): six weeks, three research runs.
 * After that it is neither checked in on nor a kit in flight, unless he
 * approves it again.
 */
export const PLAN_OPEN_DAYS = 42

/** A decision as the plan rule reads it: the Phase 1 fields, each optional, read loosely upstream (parseDecision). */
export interface PlanDecision {
  proposal_id: string
  decision: string
  decided_at: string
  payload_sha256: string | null
  amended?: boolean
  amended_sha256?: string
  exact_payload?: string | null
  amount_usd?: number | null
}

/** His version of an amended decision, when its digest checks out (ENGINE-PROTOCOL.md, Amend): SHA-256 of canonical JSON of exactly { amount_usd, exact_payload }. */
export function amendedVersion(d: PlanDecision): { ok: true; text: string | null; at: string } | { ok: false } | null {
  if (d.amended !== true) return null
  const text = typeof d.exact_payload === 'string' ? d.exact_payload : null
  const sha = sha256Hex(canonicalJson({ amount_usd: typeof d.amount_usd === 'number' ? d.amount_usd : null, exact_payload: text }))
  return typeof d.amended_sha256 === 'string' && d.amended_sha256 === sha ? { ok: true, text, at: d.decided_at } : { ok: false }
}

/** One kit plan, as his decisions leave it. */
export interface KitPlan {
  plan_id: string
  product_slug: string
  /** The first 8 characters of the question's query_id. */
  q8: string
  /** When he approved it (the latest approval). */
  approved_at: string
  decision: PlanDecision
  /** His latest decision on its check-in, if any. */
  check_in: PlanDecision | null
  /**
   * His redirect: the newest of his amended approvals, on the plan itself or
   * on any of its check-ins, whose digest checks out. A later yes as it
   * stands leaves it in force; only a newer amendment that checks out
   * replaces it. Null: the kit as proposed.
   */
  redirect: { text: string | null; at: string } | null
  /** His newest amendment did not check out: never acted on, and said so. */
  unverified: boolean
}

export interface KitPlans {
  /** Approved in the last PLAN_OPEN_DAYS, not stopped, not done and not held: checked in on, and in flight. Oldest approval first. */
  open: KitPlan[]
  /** Approved, then stopped for good by his No on a check-in. */
  stopped: KitPlan[]
  /** Approved and closed (his latest decision on it is done). */
  done: KitPlan[]
  /**
   * His latest decision approves the plan only in an amended version whose
   * digest does not check out: that version is not his for certain, and the
   * engine's own he did not approve, so the plan is neither checked in on nor
   * in flight until a decision that checks out arrives.
   */
  held: KitPlan[]
}

const PLAN_ID_RE = /^aeo:kit:([a-z0-9-]+):([0-9a-f]{8})$/

/**
 * The kit plans his decisions open, stop, close and hold. Latest decision per
 * proposal wins (any number of lists may be merged first). A plan is open
 * when his latest decision on it is an approval made in the last
 * PLAN_OPEN_DAYS; a No on its check-in stops it for good (Ruling, Krish,
 * 2026-10-19: "his no stops the plan for good"); a done closes it; an
 * approval only in an amended version that does not check out holds it. His
 * redirect is read across every version he answered, so a later plain yes
 * never drops it. Derived from decisions alone: no local state.
 */
export function kitPlans(decisions: ReadonlyArray<PlanDecision | null | undefined>, at: Date): KitPlans {
  const latest = new Map<string, PlanDecision>()
  const declinedCheckIn = new Map<string, PlanDecision>()
  // Every approval he amended, per proposal: the redirect is the newest that checks out.
  const amended = new Map<string, PlanDecision[]>()
  for (const d of decisions) {
    if (!d || typeof d.proposal_id !== 'string') continue
    const had = latest.get(d.proposal_id)
    if (!had || Date.parse(d.decided_at) > Date.parse(had.decided_at)) latest.set(d.proposal_id, d)
    // A No on any version of a check-in stops its plan for good, even if a later version was answered otherwise.
    if (d.proposal_id.startsWith(CHECKIN_PREFIX) && d.decision === 'declined') {
      const seen = declinedCheckIn.get(d.proposal_id)
      if (!seen || Date.parse(d.decided_at) < Date.parse(seen.decided_at)) declinedCheckIn.set(d.proposal_id, d)
    }
    if (d.decision === 'approved' && d.amended === true) amended.set(d.proposal_id, [...(amended.get(d.proposal_id) ?? []), d])
  }
  const out: KitPlans = { open: [], stopped: [], done: [], held: [] }
  const newestFirst = (a: PlanDecision, b: PlanDecision) => Date.parse(b.decided_at) - Date.parse(a.decided_at)
  for (const [id, d] of latest) {
    const m = PLAN_ID_RE.exec(id)
    if (!m) continue
    const checkIn = latest.get(checkInId(id)) ?? null
    const stop = declinedCheckIn.get(checkInId(id)) ?? null
    // His amendments on the plan and on its check-ins, newest first: the newest
    // that checks out is the plan; one newer that does not is said, never used.
    const versions = [...(amended.get(id) ?? []), ...(amended.get(checkInId(id)) ?? [])].sort(newestFirst).map(amendedVersion)
    const redirect = versions.find((v): v is { ok: true; text: string | null; at: string } => !!v && v.ok) ?? null
    const plan: KitPlan = {
      plan_id: id, product_slug: m[1], q8: m[2], approved_at: d.decided_at, decision: d, check_in: stop ?? checkIn,
      redirect: redirect ? { text: redirect.text, at: redirect.at } : null,
      unverified: !!versions[0] && !versions[0].ok,
    }
    if (d.decision === 'done') { out.done.push(plan); continue }
    if (d.decision !== 'approved') continue
    const age = at.getTime() - Date.parse(d.decided_at)
    if (!Number.isFinite(age) || age > PLAN_OPEN_DAYS * 86_400_000) continue
    if (stop) { out.stopped.push(plan); continue }
    const own = amendedVersion(d)
    if (own && !own.ok) { out.held.push(plan); continue }
    out.open.push(plan)
  }
  const oldest = (a: KitPlan, b: KitPlan) => Date.parse(a.approved_at) - Date.parse(b.approved_at) || a.plan_id.localeCompare(b.plan_id)
  out.open.sort(oldest)
  out.stopped.sort(oldest)
  out.done.sort(oldest)
  out.held.sort(oldest)
  return out
}
