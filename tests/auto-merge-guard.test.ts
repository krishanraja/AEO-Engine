// Own-pull-requests-only auto-merge (Ruling, Krish, 2026-11-14, decision 1.11).
// Runs the real jq rule .github/workflows/auto-merge.yml runs: only a ready
// pull request of ours, at the commit whose checks passed, merges itself.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const RULE = '.github/scripts/auto-merge-pick.jq'
const SHA = 'a'.repeat(40)
const OWNER = 'krishanraja'
const ours = {
  number: 7, headRefOid: SHA, isDraft: false, isCrossRepository: false,
  author: { login: 'krishanraja' }, headRepositoryOwner: { login: OWNER },
}
const pick = (prs: unknown[]): string =>
  execFileSync('jq', ['-r', '--arg', 'sha', SHA, '--arg', 'owner', OWNER, '-f', RULE], { input: JSON.stringify(prs) }).toString().trim()

test('merges our own ready pull request at the green commit', () => {
  assert.equal(pick([ours]), '7')
})
test('merges a pull request the Actions bot opened', () => {
  assert.equal(pick([{ ...ours, author: { login: 'app/github-actions', is_bot: true } }]), '7')
})
test('never merges a fork', () => {
  assert.equal(pick([{ ...ours, isCrossRepository: true }]), '')
  assert.equal(pick([{ ...ours, headRepositoryOwner: { login: 'stranger' } }]), '')
})
test('never merges a stranger, even on our own branch', () => {
  assert.equal(pick([{ ...ours, author: { login: 'stranger' } }]), '')
  assert.equal(pick([{ ...ours, author: null }]), '')
})
test('leaves drafts and other commits alone', () => {
  assert.equal(pick([{ ...ours, isDraft: true }]), '')
  assert.equal(pick([{ ...ours, headRefOid: 'b'.repeat(40) }]), '')
  assert.equal(pick([]), '')
})
test('the workflow waits on this repository\'s own checks and refuses a run from elsewhere', () => {
  const wf = readFileSync('.github/workflows/auto-merge.yml', 'utf8')
  assert.match(wf, /workflows: \["CI"\]/)
  assert.match(wf, /CHECKS: CI\n/)
  assert.match(wf, /workflow_run\.head_repository\.full_name == github\.repository/)
  assert.match(wf, /workflow_run\.event == 'pull_request'/)
  assert.match(wf, /-f \.github\/scripts\/auto-merge-pick\.jq/)
  assert.match(wf, /isCrossRepository,author,headRepositoryOwner/)
})
