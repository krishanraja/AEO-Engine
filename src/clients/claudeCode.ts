/**
 * The Claude Code lane: Claude probes on the Claude Code subscription token
 * instead of the paid Messages API (Ruling, Krish, 2026-11-13: Claude probes
 * run on the Claude Code subscription token, with the paid API as a
 * switch-on fallback).
 *
 * One fresh, headless CLI session per question, as close to a member of the
 * public asking a consumer assistant as the CLI allows:
 *
 *   - a neutral, versioned system prompt that names no venture (PROBE_SYSTEM_V1);
 *   - WebSearch the only tool, and the only tool allowed;
 *   - no MCP server (an empty, strict MCP config);
 *   - a fresh empty working directory and a fresh empty HOME, removed after,
 *     so no CLAUDE.md, AGENTS.md or settings from this repository or the
 *     runner can reach the probe;
 *   - a child environment built from an allowlist (childEnv), never a copy of
 *     this process's environment, so the child cannot see an API key and
 *     cannot bill the API;
 *   - the CLI's normal permission handling: no flag that skips permissions
 *     and no minimal mode is ever passed (check:config refuses both).
 *
 * It fails closed. The CLI's first event says which tools it loaded, where
 * its API key came from and which MCP servers connected; anything other than
 * WebSearch alone, an API key source other than 'none' (the value a
 * subscription token alone reports; a missing one is refused too), or a
 * connected MCP server ends the probe before it can answer, and the probe is
 * failed.
 *
 * Reading the stream (stream-json, recorded from Claude Code 2.1.323 on
 * 2026-11-13; the tests' fixtures are synthetic, in the same shape):
 *   system init       the fail-closed checks above
 *   assistant         a WebSearch tool_use's input.query goes to fan_out, and
 *                     any WebSearch tool_use means the probe searched
 *   user              tool_use_result.results[].content[].url, in order, each
 *                     once, are what the searches returned (retrieved); when
 *                     tool_use_result is absent, the JSON list after "Links: "
 *                     in the tool_result text
 *   rate_limit_event  allowed: nothing. allowed_warning: the subscription is past
 *                     a warning threshold and still serving, so the probe
 *                     finishes and is counted (limit_warning). rejected, any
 *                     status this CLI does not declare, or isUsingOverage true
 *                     (paid extra usage is covering the overflow): the
 *                     subscription's limit (SubscriptionLimit); the probe is
 *                     failed and counted
 *   result            the answer text; a failed result fails the probe
 *
 * The answer is plain text, so its citations are the URLs its text carries
 * that its searches returned, in order of first appearance, each once. A URL
 * the model typed that no search returned is dropped and counted
 * (typed_urls_dropped): it is not a source the assistant read.
 *
 * Its tokens go to the usage meter with billing `subscription` (never posted
 * as a priced row, src/lib/usage.ts), and the ledger counts the call at its
 * own cost kind, claude_code, which is never charged (src/config/run.ts).
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { CAPS, MODELS, type CostKind } from '../config/run.js'
import type { UsageMeter } from '../lib/usage.js'
import { asArray, asRecord, asString } from './http.js'
import { SubscriptionLimit, type EngineAnswer, type EngineClient } from './types.js'

export { SubscriptionLimit }

/**
 * The probe's system prompt, version 1. Neutral, like a consumer assistant,
 * and naming no venture: a probe measures what a buyer would be told, not
 * what we would like them told. Change it only as a new versioned constant,
 * because every reading after the change is a different measurement.
 */
export const PROBE_SYSTEM_V1 = 'You are a helpful assistant answering a question from a member of the public. Search the web before you answer and cite the sources you rely on with links.'
export const PROBE_SYSTEM_VERSION = 'v1'

/** The one tool a probe may load and use. */
export const PROBE_TOOL = 'WebSearch'
/** No MCP server at all; with --strict-mcp-config no other configuration is read. */
export const EMPTY_MCP_CONFIG = '{"mcpServers":{}}'
/** One probe's deadline, the same four minutes the API lanes allow (anthropic.ts, PROBE_TIMEOUT_MS). */
export const CLAUDE_CODE_PROBE_TIMEOUT_MS = 240_000

/** The only variables the child process is given. Everything else, API keys included, stays in this process. */
export const CHILD_ENV_KEYS = ['PATH', 'HOME', 'CLAUDE_CODE_OAUTH_TOKEN', 'DISABLE_AUTOUPDATER', 'DISABLE_TELEMETRY', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'] as const

/**
 * The child's environment, built fresh from the allowlist: PATH from this
 * process, the temporary HOME, the subscription token, and three switches
 * that keep the CLI from updating itself, reporting telemetry or making any
 * call it does not need. Never a copy of `parentEnv`. Pure.
 */
export function childEnv(parentEnv: NodeJS.ProcessEnv, home: string): Record<string, string> {
  const env: Record<string, string> = {}
  if (parentEnv.PATH) env.PATH = parentEnv.PATH
  env.HOME = home
  if (parentEnv.CLAUDE_CODE_OAUTH_TOKEN) env.CLAUDE_CODE_OAUTH_TOKEN = parentEnv.CLAUDE_CODE_OAUTH_TOKEN
  env.DISABLE_AUTOUPDATER = '1'
  env.DISABLE_TELEMETRY = '1'
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  return env
}

/**
 * The CLI's arguments for one question. A question that starts with a dash
 * gets one leading space, so the CLI reads it as the prompt and never as a
 * flag; the space changes nothing the model reads. Pure.
 */
export function claudeCodeArgs(question: string, model: string, maxTurns: number = CAPS.CLAUDE_CODE_MAX_TURNS): string[] {
  const prompt = question.startsWith('-') ? ` ${question}` : question
  return [
    '-p', prompt,
    '--system-prompt', PROBE_SYSTEM_V1,
    '--tools', PROBE_TOOL,
    '--allowedTools', PROBE_TOOL,
    '--output-format', 'stream-json', '--verbose',
    '--max-turns', String(maxTurns),
    '--model', model,
    '--strict-mcp-config', '--mcp-config', EMPTY_MCP_CONFIG,
  ]
}

/** The probe was refused before it could answer: the CLI was not set up the way a probe must be. */
export class ProbeRefused extends Error {
  constructor(public readonly code: string) {
    super(code)
    this.name = 'ProbeRefused'
  }
}

/** A stream of chunks, as a child process's stdout gives them. */
export interface ChunkSource { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown }

/** What the lane needs of a child process. node:child_process gives more; a test's fake gives this. */
export interface ProbeChild {
  readonly stdout: ChunkSource | null
  readonly stderr: ChunkSource | null
  on(event: string, listener: (...args: any[]) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

export interface SpawnOptions { cwd: string; env: Record<string, string>; stdio: ['ignore', 'pipe', 'pipe'] }
export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ProbeChild

/** node:child_process spawn, with no shell: the question is an argument, never a command line. */
export const defaultSpawn: SpawnFn = (command, args, options) => nodeSpawn(command, [...args], { ...options, shell: false })

const pushOnce = (list: string[], v: unknown) => {
  const s = asString(v).trim()
  if (s && !list.includes(s)) list.push(s)
}

/** Every URL in a JSON list that follows "Links: " in a tool_result text, in order. Never throws. */
export function linksFrom(text: string): string[] {
  const out: string[] = []
  let from = 0
  for (;;) {
    const at = text.indexOf('Links:', from)
    if (at < 0) break
    const open = text.indexOf('[', at)
    if (open < 0) break
    const close = matchingBracket(text, open)
    from = close > open ? close + 1 : open + 1
    if (close < 0) continue
    try {
      for (const item of asArray(JSON.parse(text.slice(open, close + 1)))) pushOnce(out, typeof item === 'string' ? item : asRecord(item).url)
    } catch {
      // Not JSON after all: nothing read from it.
    }
  }
  return out.filter(u => /^https?:\/\//i.test(u))
}

/** The index of the bracket closing the one at `open`, skipping brackets inside JSON strings; -1 when unbalanced. */
function matchingBracket(s: string, open: number): number {
  let depth = 0
  let inString = false
  for (let i = open; i < s.length; i++) {
    const c = s[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '[' || c === '{') depth++
    else if (c === ']' || c === '}') {
      depth--
      if (depth === 0) return c === ']' ? i : -1
    }
  }
  return -1
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"'`[\]{}|\\^]+/g
const TRAILING = /[.,;:!?*_'"]$/

/**
 * The URLs an answer's text carries, markdown links and bare URLs alike, in
 * order of first appearance, each once, with trailing punctuation trimmed (a
 * closing parenthesis only when it has no opening one in the URL). Pure.
 */
export function urlsInText(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(URL_IN_TEXT)) {
    let u = m[0]
    for (;;) {
      if (TRAILING.test(u)) { u = u.slice(0, -1); continue }
      if (u.endsWith(')') && (u.match(/\(/g) ?? []).length < (u.match(/\)/g) ?? []).length) { u = u.slice(0, -1); continue }
      break
    }
    if (/^https?:\/\/[^/]+/i.test(u)) pushOnce(out, u)
  }
  return out
}

/** A URL's identity for matching typed text to search results: host without www, path without a trailing slash, query; scheme and fragment ignored. */
export function urlKey(u: string): string {
  try {
    const x = new URL(u)
    return `${x.hostname.toLowerCase().replace(/^www\./, '')}${x.pathname.replace(/\/+$/, '')}${x.search}`
  } catch {
    return u.trim().toLowerCase()
  }
}

/**
 * The answer's citations: each URL in the text that a search returned, as
 * the search returned it, in order of first appearance, each once; and how
 * many distinct URLs the text carried that no search returned. Pure.
 */
export function citeFromText(text: string, retrieved: readonly string[]): { citations: string[]; typed_urls_dropped: number } {
  const byKey = new Map<string, string>()
  for (const r of retrieved) if (!byKey.has(urlKey(r))) byKey.set(urlKey(r), r)
  const citations: string[] = []
  const dropped = new Set<string>()
  for (const u of urlsInText(text)) {
    const hit = byKey.get(urlKey(u))
    if (hit) pushOnce(citations, hit)
    else dropped.add(urlKey(u))
  }
  return { citations, typed_urls_dropped: dropped.size }
}

/**
 * The API key source a probe may report: none. A subscription token alone
 * reports it (Claude Code 2.1.323). The CLI also names ANTHROPIC_API_KEY,
 * apiKeyHelper, '/login managed key' (a saved Console API key, billed to the
 * API), user, project, org, temporary and oauth; every one of those, and a
 * missing or non-string field, is refused. An allowlist, so a source a later
 * CLI adds is refused until a test says otherwise.
 */
export const ALLOWED_API_KEY_SOURCE = 'none'

/** The fail-closed checks on the CLI's init event. Throws ProbeRefused; returns nothing. */
export function checkInit(e: Record<string, unknown>): void {
  const tools = Array.isArray(e.tools) ? e.tools.map(String) : null
  if (!tools || tools.length !== 1 || tools[0] !== PROBE_TOOL) throw new ProbeRefused('claude_code_tools_not_websearch_only')
  if (e.apiKeySource !== ALLOWED_API_KEY_SOURCE) throw new ProbeRefused('claude_code_api_key_source')
  if (asArray(e.mcp_servers).some(s => asRecord(s).status === 'connected')) throw new ProbeRefused('claude_code_mcp_connected')
}

/** The rate limit statuses under which the subscription is still serving without paid overage. */
const SERVING = new Set(['allowed', 'allowed_warning'])

/**
 * Reads one probe's stream-json events, one at a time. feed() throws to stop
 * the probe early (a refused init, a tool other than WebSearch, the
 * subscription's limit); finish() reads what the stream said once it ended.
 */
export class ProbeStreamReader {
  private init = false
  private searched = false
  private limitWarning = false
  private readonly fanOut: string[] = []
  private readonly retrieved: string[] = []
  private result: Record<string, unknown> | null = null

  feed(event: unknown): void {
    const e = asRecord(event)
    switch (e.type) {
      case 'system':
        if (e.subtype === 'init' && !this.init) { checkInit(e); this.init = true }
        return
      case 'rate_limit_event': {
        // allowed_warning is a warning threshold passed while requests are
        // still served; it never means paid overage, which the CLI reports as
        // rejected with isUsingOverage. So a warning lets the probe finish
        // (and is counted), and only rejected, a status this CLI does not
        // declare, or overage in use stops the lane.
        const info = asRecord(e.rate_limit_info)
        const status = asString(info.status)
        if (info.isUsingOverage === true) throw new SubscriptionLimit(`${status || 'unknown'}_overage`, asString(info.rateLimitType))
        if (!SERVING.has(status)) throw new SubscriptionLimit(status || 'unknown', asString(info.rateLimitType))
        if (status === 'allowed_warning') this.limitWarning = true
        return
      }
      case 'assistant':
        this.requireInit()
        for (const block of asArray(asRecord(e.message).content)) {
          const b = asRecord(block)
          if (b.type !== 'tool_use') continue
          if (b.name !== PROBE_TOOL) throw new ProbeRefused('claude_code_tool_not_websearch')
          this.searched = true
          const q = asString(asRecord(b.input).query).trim()
          if (q) this.fanOut.push(q)
        }
        return
      case 'user': {
        this.requireInit()
        const tur = e.tool_use_result
        if (tur && typeof tur === 'object' && !Array.isArray(tur)) {
          for (const r of asArray(asRecord(tur).results)) {
            if (typeof r === 'string') continue
            for (const c of asArray(asRecord(r).content)) pushOnce(this.retrieved, asRecord(c).url)
          }
          return
        }
        for (const block of asArray(asRecord(e.message).content)) {
          const b = asRecord(block)
          if (b.type !== 'tool_result') continue
          const text = typeof b.content === 'string' ? b.content : asArray(b.content).map(x => asString(asRecord(x).text)).join('\n')
          for (const u of linksFrom(text)) pushOnce(this.retrieved, u)
        }
        return
      }
      case 'result':
        this.result = e
        return
      default:
        return
    }
  }

  private requireInit(): void {
    if (!this.init) throw new ProbeRefused('claude_code_no_init')
  }

  /** The answer, or the reason the probe failed; the usage whenever the stream reported one. */
  finish(): { answer: EngineAnswer | null; usage: unknown; error: string | null } {
    const r = this.result
    if (!r) return { answer: null, usage: undefined, error: this.init ? 'claude_code_no_result' : 'claude_code_no_init' }
    const usage = r.usage
    if (!this.init) return { answer: null, usage, error: 'claude_code_no_init' }
    if (r.is_error === true || r.subtype !== 'success') return { answer: null, usage, error: `claude_code_result_${asString(r.subtype) || 'error'}` }
    const text = asString(r.result).trim()
    const { citations, typed_urls_dropped } = citeFromText(text, this.retrieved)
    const answer: EngineAnswer = { text, citations, retrieved: [...this.retrieved], searched: this.searched, fan_out: [...this.fanOut], typed_urls_dropped }
    if (this.limitWarning) answer.limit_warning = true
    if (usage !== undefined) answer.usage = usage
    return { answer, usage, error: null }
  }
}

/** One probe's events, read whole. Throws as feed() would. Pure; exported for the tests. */
export function readProbeStream(events: readonly unknown[]): { answer: EngineAnswer | null; usage: unknown; error: string | null } {
  const reader = new ProbeStreamReader()
  for (const e of events) reader.feed(e)
  return reader.finish()
}

export interface ClaudeCodeOptions {
  /** Where the subscription token and PATH are read from. The child is never given this whole. */
  env?: NodeJS.ProcessEnv
  meter?: UsageMeter
  spawn?: SpawnFn
  /** The CLI's command name, resolved on PATH. */
  command?: string
  timeoutMs?: number
  /** code_then_api: the lane asked instead when the subscription's limit stops a probe. */
  fallback?: EngineClient
}

export class ClaudeCodeEngine implements EngineClient {
  readonly engine = 'claude' as const
  /** The model the CLI is asked for, by the same id the API lane uses. */
  readonly cliModel: string = MODELS.anthropic
  /** What the probe reports, so a reader can tell the lanes apart. */
  readonly model = `claude-code/${MODELS.anthropic}`
  readonly costKind: CostKind = 'claude_code'
  readonly fallback?: EngineClient
  private readonly env: NodeJS.ProcessEnv
  private readonly spawn: SpawnFn
  private readonly command: string
  private readonly timeoutMs: number
  private readonly meter?: UsageMeter
  /**
   * Set once the subscription's limit stops a probe. The limit is a rolling
   * window longer than a research job, so the rest of the job's probes stop
   * at once instead of each starting a session to be told the same thing.
   */
  private limited: SubscriptionLimit | null = null

  constructor(opts: ClaudeCodeOptions = {}) {
    this.env = opts.env ?? process.env
    if (!this.env.CLAUDE_CODE_OAUTH_TOKEN) throw new Error('CLAUDE_CODE_OAUTH_TOKEN is not set')
    this.spawn = opts.spawn ?? defaultSpawn
    this.command = opts.command ?? 'claude'
    this.timeoutMs = opts.timeoutMs ?? CLAUDE_CODE_PROBE_TIMEOUT_MS
    this.meter = opts.meter
    if (opts.fallback) this.fallback = opts.fallback
  }

  async ask(question: string): Promise<EngineAnswer> {
    if (this.limited) throw this.limited
    const home = await mkdtemp(join(tmpdir(), 'aeo-probe-home-'))
    const work = await mkdtemp(join(tmpdir(), 'aeo-probe-work-'))
    try {
      return await this.run(question, home, work)
    } catch (e) {
      if (e instanceof SubscriptionLimit) this.limited = e
      throw e
    } finally {
      await Promise.all([rm(home, { recursive: true, force: true }), rm(work, { recursive: true, force: true })])
    }
  }

  private run(question: string, home: string, work: string): Promise<EngineAnswer> {
    return new Promise<EngineAnswer>((resolve, reject) => {
      const reader = new ProbeStreamReader()
      let child: ProbeChild
      try {
        child = this.spawn(this.command, claudeCodeArgs(question, this.cliModel), { cwd: work, env: childEnv(this.env, home), stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (e) {
        reject(new Error(`claude_code_spawn_failed: ${asString((e as NodeJS.ErrnoException)?.code) || 'error'}`))
        return
      }
      let settled = false
      let buf = ''
      // One decoder for the whole stream: a multi-byte character split across
      // two reads of the pipe is joined here, never turned into U+FFFD.
      const decoder = new StringDecoder('utf8')
      const done = (err: Error | null, value?: EngineAnswer) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (err) {
          try { child.kill('SIGKILL') } catch { /* already gone */ }
          reject(err)
        } else resolve(value as EngineAnswer)
      }
      const timer = setTimeout(() => done(new Error(`claude_code_timeout after ${this.timeoutMs}ms`)), this.timeoutMs)
      const onLine = (line: string) => {
        const t = line.trim()
        if (!t || settled) return
        let event: unknown
        try { event = JSON.parse(t) } catch { return }
        try { reader.feed(event) } catch (e) { done(e as Error) }
      }
      child.stdout?.on('data', chunk => {
        if (settled) return
        buf += typeof chunk === 'string' ? chunk : decoder.write(chunk)
        let i: number
        while (!settled && (i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i)
          buf = buf.slice(i + 1)
          onLine(line)
        }
      })
      // Drained so the pipe never fills; never logged, because it is the CLI's own text.
      child.stderr?.on('data', () => {})
      child.on('error', (e: NodeJS.ErrnoException) => done(new Error(`claude_code_spawn_failed: ${asString(e?.code) || 'error'}`)))
      child.on('close', (code: number | null) => {
        if (settled) return
        buf += decoder.end()
        if (buf.trim()) onLine(buf)
        buf = ''
        if (settled) return
        const out = reader.finish()
        // Recorded whether or not the probe passed: a failed answer still used the subscription.
        if (out.usage !== undefined) this.meter?.record('aeo-probe', this.model, out.usage, out.error !== null, 'subscription')
        if (out.error || !out.answer) return done(new Error(`${out.error ?? 'claude_code_no_answer'}${code ? ` (exit ${code})` : ''}`))
        done(null, out.answer)
      })
    })
  }
}
