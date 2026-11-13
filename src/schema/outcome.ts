/**
 * A venture's outcomes in counts (src/pipeline/63-outcomes.ts), as the sealed
 * run summary carries them and the protocol report reads them. Shapes only,
 * so the protocol never imports the pipeline. Null is unknown: the signal
 * was not served, never zero.
 */
export interface ReferralCounts { sessions: number; pages: number }

export interface OutcomeCounts {
  /** Which signals Control Center served for the subject. */
  served: { gsc: boolean; bing: boolean; ga4: boolean; clarity: boolean }
  /** Answer pages tracked: the pages a venture shipped, and the pages its kits target. */
  pages: number
  /** AI-referral sessions to those pages in the window, and how many pages had any; GA4 and Clarity apart, never summed. */
  ga4: ReferralCounts | null
  clarity: ReferralCounts | null
  /** Search Console impressions and clicks to those pages in the window, and how many pages had an impression. */
  gsc: { impressions: number; clicks: number; pages: number } | null
  /** The window, in days. */
  days: number
}
