import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hostKey, ownerRepoFor, ownerRepoOf, parseSubjectsConfig, subjectsConfig } from '../src/config/subjects.js'

// Fleet integration I-10: a site fix names the repository that ships its host.

const base = { _about: 'synthetic', held: [], owner_repos: { mindmake: 'krishanraja/mindmake', heartside: 'krishanraja/heartside' } }

test('host_repos: a host entry wins over the product, null means no repository ships it, no entry falls back', () => {
  const parsed = parseSubjectsConfig({ ...base, host_repos: { 'krishraja.com': 'krishanraja/krish-raja', 'krishraja.ai': null } })
  assert.equal(parsed.ok, true)
  const cfg = parsed.ok ? parsed.value : null!
  assert.deepEqual(ownerRepoFor('mindmake', cfg, 'www.KrishRaja.com'), { repo: 'krishanraja/krish-raja', basis: 'host' })
  assert.deepEqual(ownerRepoFor('mindmake', cfg, 'krishraja.ai'), { repo: null, basis: 'host' }, 'a Cloudflare copy no repository ships')
  assert.deepEqual(ownerRepoFor('mindmake', cfg, 'mindmake.co'), { repo: 'krishanraja/mindmake', basis: 'product' })
  assert.deepEqual(ownerRepoFor(null, cfg, 'unknown.example'), { repo: null, basis: 'none' })
  assert.equal(ownerRepoOf('heartside', cfg), 'krishanraja/heartside', 'no host: the product, as before')
  assert.equal(hostKey(' WWW.Example.com:443 '), 'example.com')
})

test('host_repos: refused when a key is not a lowercase host without www, or a value is not owner/name or null', () => {
  for (const bad of [{ 'www.krishraja.com': 'krishanraja/krish-raja' }, { 'KrishRaja.com': 'a/b' }, { 'https://x.com': 'a/b' }, { 'x.com': 'not a repo' }, { 'x.com': 7 }]) {
    assert.equal(parseSubjectsConfig({ ...base, host_repos: bad }).ok, false, JSON.stringify(bad))
  }
  assert.equal(parseSubjectsConfig({ ...base, host_repos: [] }).ok, false)
  assert.equal(parseSubjectsConfig(base).ok, true, 'host_repos is optional')
})

test('the shipped map: his own site ships in krish-raja, CTRL\'s page in mindmake-ctrl, Substack in none', () => {
  const cfg = subjectsConfig()
  assert.equal(ownerRepoOf('mindmake', cfg, 'www.krishraja.com'), 'krishanraja/krish-raja')
  assert.equal(ownerRepoOf('ctrl', cfg, 'ctrl.mindmake.co'), 'krishanraja/mindmake-ctrl')
  assert.equal(ownerRepoOf('ctrl', cfg, 'mindmake.co'), 'krishanraja/mindmake')
  assert.equal(ownerRepoOf('publication', cfg, 'home.makeyourmindup.ai'), null)
  assert.equal(ownerRepoOf('heartside', cfg, 'heartside.io'), 'krishanraja/heartside', 'no host entry: the product\'s repository')
})
