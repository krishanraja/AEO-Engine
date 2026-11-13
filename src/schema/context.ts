/** The shape of GET /api/aeo/context as Control Center serves it. */
import type { Engine, ProductSlug, QueryStatus, SubjectKind, Trend } from './packet.js'
import type { Panel } from './panel.js'

export interface RoomTarget {
  id: string
  company: string
  title: string
  why_face: string
  trigger_signal: string | null
  trigger_source_url: string | null
  state: string
}

export interface Touchpoint {
  id: string
  icp_trigger: string
  watering_hole: string
  coverage_status: string
  cost_efficiency_score: number | null
}

export interface StrikingDistanceRow {
  query: string
  current_position: number | null
  previous_position: number | null
  search_volume: number | null
  priority: number | null
  last_checked_at: string | null
}

export interface PriorProbe {
  id: string
  question: string
  engine: Engine
  we_cited: boolean
  competitors_cited: string[]
  run_at: string
  run_id: string | null
  query_id: string | null
}

export interface PriorQuery {
  query_id: string
  query: string
  demand_score: number
  status: QueryStatus
  trend: Trend
  /**
   * The panel this engine sent for the question last run (the packet's
   * `panel` feature), once Control Center serves it back. Optional and read
   * loosely (src/pipeline/55-panel.ts): absent, null or misshapen means the
   * history before this run is unknown, and nothing is guessed.
   */
  panel?: Panel | null
}

/**
 * A page a venture said it shipped for one of its questions (Control
 * Center's venture declarations, or a 1.23.0 request's `shipped`). Optional,
 * read loosely: names the question by query_id or by its words.
 */
export interface ShippedDeclaration {
  query_id?: string
  question?: string
  url: string
  shipped_at: string | null
  by?: string
}

export interface PriorWeek {
  week_start: string
  watch_list: Array<{ query_id?: string; query: string; why?: string }>
  queries: PriorQuery[]
  recommendations: Array<{ title?: string; target_query?: string; query_id?: string }>
  /**
   * Optional (brief section J): the cited-pages sheet Control Center holds
   * for this venture, its AEO-owned columns as this engine last sent them.
   * Read loosely by normalised URL (src/pipeline/48-cited-pages.ts); without
   * it no mention is said to have been acquired or lost.
   */
  cited_pages?: Array<{ url?: unknown; mention?: unknown }>
}

/**
 * Control Center's search signals for a subject (brief section C), read
 * loosely (src/pipeline/63-outcomes.ts). Keys stay in Control Center; this
 * engine holds no Search Console, Bing, GA4 or Clarity credential. Missing
 * is unknown, never zero.
 */
export interface SearchSignals {
  gsc_queries?: Array<{ query?: unknown; page?: unknown; impressions?: unknown; clicks?: unknown; position?: unknown; date_from?: unknown; date_to?: unknown }> | null
  bing?: { queries?: unknown; pages?: unknown; url_info?: Array<{ url?: unknown; indexed?: unknown; last_crawled?: unknown }> | null; crawl_issues?: unknown; keyword_volume?: unknown } | null
  /** AI-assistant referrals, each row from GA4 or Clarity (`via`); never summed across the two, which count differently. */
  ai_referrals?: Array<{ landing_page?: unknown; source?: unknown; sessions?: unknown; date?: unknown; via?: unknown }> | null
  /** The first shape the brief named: GA4 rows only, read as via ga4. */
  ga4_ai_referrals?: Array<{ landing_page?: unknown; source?: unknown; sessions?: unknown; date?: unknown }> | null
}

/**
 * One brand-accuracy check (brief section B6): a question, phrases an answer
 * must never use about the brand, and phrases it must use. Control Center
 * serves them; read loosely (src/pipeline/42-brand.ts).
 */
export interface BrandCheckSpec { question: string; must_not: string[]; must: string[] }

export interface ContextSubject {
  id: string
  kind: SubjectKind
  slug: string
  name: string
  domains: string[]
  competitor_domains: string[]
  icp_line: string
  seed_topics: string[]
  never_say: string[]
  product_slug: ProductSlug | null
  lane_slug: string | null
  room_target: RoomTarget | null
  touchpoints: Touchpoint[]
  striking_distance: StrikingDistanceRow[]
  probes_4w: PriorProbe[]
  prior: PriorWeek | null
  /**
   * Whether Control Center holds this venture's growth engine. Optional and
   * read loosely: absent until Control Center serves it, and then
   * config/subjects.json's held list decides (src/config/subjects.ts). When
   * present it wins: a held venture is measured and gets no win kit.
   */
  engine_held?: boolean
  /** Optional: the pages this venture said it shipped for its questions. They are probed first, after its requests. */
  shipped?: ShippedDeclaration[]
  /**
   * Optional: the subject's distinctive names (Heartside, Mindmake), never a
   * generic word. An answer that names one, outside any URL, is a name
   * mention. Absent or empty: unknown, and every probe's name_mentioned is null.
   */
  brand_names?: string[]
  /** Optional: read-only search signals for outcomes (brief section C). Absent: every outcome is unknown. */
  search_signals?: SearchSignals | null
  /** Optional: brand-accuracy checks (brief section B6), at most three asked a research run. */
  brand_checks?: BrandCheckSpec[] | null
}

export interface AeoContext {
  ok: true
  week_start: string
  generated_at: string
  krish: {
    name: string
    domains: string[]
    /** The krish-voice body Control Center holds once and every content call
     *  is grounded in. Absent or empty on an older Control Center, and on a
     *  read failure, in which case the digest writes plainly rather than in a
     *  voice it guessed at. */
    voice_block?: string
    /** The writers Krish rates, each with the move he rates them for. The
     *  same registry the Content engine's Tuesday scrape reads. */
    voices_he_rates?: Array<{ name: string; why: string }>
    /** The business canon: 00_NORTH_STAR.md from the business repo, the file
     *  that repo calls the one to read if you read only one. Positioning,
     *  what is sold, who the buyer is, what the business believes and what it
     *  refuses to say. The digest needs it to judge which answers are
     *  winnable rather than merely unoccupied. Absent or empty on an older
     *  Control Center, and on a read failure: the digest then makes no
     *  winnability claim rather than one it guessed at. */
    canon?: string
  }
  icp: { room_face: { who: string; who_not: string } }
  subjects: ContextSubject[]
  /**
   * What Control Center's packet ingest accepts beyond the closed v1 shape,
   * read as optional: absent means none. `engine_gemini` lets Gemini's probes
   * into the packet (src/schema/packet.ts, GATED_ENGINES); until it is listed
   * they are counted only in the sealed run summary. Every other optional
   * field (PACKET_FEATURES) is sent only when its feature is listed.
   */
  packet_features?: string[]
}
