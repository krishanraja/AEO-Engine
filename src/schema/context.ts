/** The shape of GET /api/aeo/context as Control Center serves it. */
import type { Engine, ProductSlug, QueryStatus, SubjectKind, Trend } from './packet.js'

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
}

export interface PriorWeek {
  week_start: string
  watch_list: Array<{ query_id?: string; query: string; why?: string }>
  queries: PriorQuery[]
  recommendations: Array<{ title?: string; target_query?: string; query_id?: string }>
}

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
  }
  icp: { room_face: { who: string; who_not: string } }
  subjects: ContextSubject[]
}
