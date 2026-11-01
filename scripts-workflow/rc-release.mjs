import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const env = process.env
const repository = env.GITHUB_REPOSITORY
const reviewers = ['Tunglies', 'wonfen']
const versionPattern = '(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)'
const rcPattern = new RegExp(`^v${versionPattern}-rc(?:\\.(0|[1-9][0-9]*))?$`)
const stablePattern = new RegExp(`^v${versionPattern}$`)
const versionFiles = [
  'package.json',
  'src-tauri/tauri.conf.json',
  'src-tauri/Cargo.toml',
  'Cargo.lock',
]
const read = (path) => readFileSync(path, 'utf8')
const json = (path) => JSON.parse(read(path))
const run = (command, args, options = {}) =>
  execFileSync(command, args, { encoding: 'utf8', ...options }).trim()
const git = (...args) => run('git', args)
const isRc = (tag) => tag.match(rcPattern)?.[0] === tag
const branchTag = (branch) =>
  branch.startsWith('release/') && isRc(branch.slice(8))
    ? branch.slice(8)
    : undefined
const latest = (tags) =>
  tags.sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).at(-1)
const summary = (text) => appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`)
const candidatePath = () => join(env.RUNNER_TEMP, 'rc-candidate.json')
const endpoint = (path) =>
  path === 'graphql' ? path : `repos/${repository}/${path}`
const list = (path) =>
  JSON.parse(run('gh', ['api', '--paginate', '--slurp', endpoint(path)])).flat()

function api(path, body) {
  return JSON.parse(
    run('gh', ['api', '--method', 'POST', endpoint(path), '--input', '-'], {
      input: JSON.stringify(body),
    }),
  )
}

function output(values) {
  appendFileSync(
    env.GITHUB_OUTPUT,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(''),
  )
}

function validateVersions(tag) {
  for (const path of versionFiles) {
    const version = path.endsWith('.json')
      ? json(path).version
      : read(path).match(
          path === 'Cargo.lock'
            ? /\[\[package\]\]\r?\nname = "clash-verge"\r?\nversion = "([^"]+)"/
            : /^version\s*=\s*"([^"]+)"/m,
        )?.[1]
    if (`v${version}` !== tag)
      throw new Error(`${path} version does not match ${tag}.`)
  }
}

function prepare() {
  const existing = list('pulls?state=open&base=main&per_page=100').find(
    (pr) => pr.head.repo?.full_name === repository && branchTag(pr.head.ref),
  )
  if (existing) {
    output({ existing_pr: existing.html_url })
    summary(
      `Existing RC PR: ${existing.html_url}\nClose it before preparing a replacement; its candidate is unchanged.`,
    )
    return
  }
  const requested = env.RC_TAG || ''
  if (requested && !isRc(requested))
    throw new Error('Expected vX.Y.Z-rc or vX.Y.Z-rc.N.')
  const base = (requested || `v${json('package.json').version}`).split(
    /[-+]/,
  )[0]
  if (!stablePattern.test(base))
    throw new Error(`Invalid base version: ${base}`)
  const refs = git('ls-remote', '--heads', '--tags', '--refs', 'origin')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t')[1])
  const tags = refs
    .filter((ref) => ref.startsWith('refs/tags/'))
    .map((ref) => ref.slice(10))
  const reserved = refs
    .filter((ref) => ref.startsWith('refs/heads/'))
    .map((ref) => branchTag(ref.slice(11)))
    .filter(Boolean)
  const sameBase = (tag) => isRc(tag) && tag.startsWith(`${base}-rc`)
  const occupied = [...tags, ...reserved]
  const last = latest(occupied.filter(sameBase))
  const tag =
    requested ||
    (last
      ? `${base}-rc.${BigInt(last.match(rcPattern)[4] ?? 0) + 1n}`
      : `${base}-rc`)
  if (occupied.includes(tag))
    throw new Error(`Tag ${tag} already exists or is reserved.`)
  const previous =
    latest(tags.filter(sameBase)) ||
    latest(tags.filter((tag) => stablePattern.test(tag)))
  const sha = git('rev-parse', 'HEAD')
  const url = `${env.GITHUB_SERVER_URL}/${repository}`
  let comparison = 'No previous release tag; showing the source commit.'
  let commits = git('log', '-1', '--format=%h %s', sha)
  if (previous) {
    git('fetch', '--no-tags', 'origin', `refs/tags/${previous}`)
    const previousSha = git('rev-parse', 'FETCH_HEAD^{commit}')
    const range = `${previousSha}..${sha}`
    comparison = `[Changes since ${previous}](${url}/compare/${previousSha}...${sha}); ${git('rev-list', '--count', range)} commits (up to 50 shown).`
    commits = git('log', '--max-count=50', '--format=%h %s', range)
  }
  const escaped = (commits || 'No new commits.')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
  const body = `## Problem
Prepare ${tag} from dev at [${sha}](${url}/commit/${sha}).

## Approach
This candidate fixes the dev snapshot and updates the four version files. Later dev commits are not added automatically.
Tunglies or wonfen must merge this PR or approve its current head. Merging into main publishes its merge commit after all nine builds succeed.
If GitHub requests approval to run the PR checks, select "Approve workflows to run".

## Scope
${comparison}
<pre>${escaped}</pre>
`
  summary(body)
  writeFileSync(candidatePath(), JSON.stringify({ tag, sha, body }))
  output({ release_tag: tag })
}

function createPr() {
  const { tag, sha, body } = json(candidatePath())
  if (json('package.json').version !== tag.slice(1))
    run('node', ['scripts/release-version.mjs', tag])
  validateVersions(tag)
  const branch = `release/${tag}`
  // Create-only ref and expectedHeadOid prevent replacing another candidate.
  api('git/refs', { ref: `refs/heads/${branch}`, sha })
  const commit = api('graphql', {
    query: `mutation($input: CreateCommitOnBranchInput!) {
      createCommitOnBranch(input: $input) { commit { oid } }
    }`,
    variables: {
      input: {
        branch: { repositoryNameWithOwner: repository, branchName: branch },
        expectedHeadOid: sha,
        message: { headline: `chore(release): prepare ${tag}` },
        fileChanges: {
          additions: versionFiles.map((path) => ({
            path,
            contents: readFileSync(path).toString('base64'),
          })),
        },
      },
    },
  })
  if (commit.errors || !commit.data?.createCommitOnBranch?.commit?.oid)
    throw new Error(
      `Signed version commit failed: ${JSON.stringify(commit.errors)}`,
    )
  const pr = api('pulls', {
    head: branch,
    base: 'main',
    title: `chore(release): prepare ${tag}`,
    body,
  })
  summary(`RC pull request: ${pr.html_url}`)
  api(`pulls/${pr.number}/requested_reviewers`, { reviewers })
}

function validate() {
  const pr = json(env.GITHUB_EVENT_PATH).pull_request
  const tag = branchTag(pr.head.ref)
  if (!tag) throw new Error('Expected an RC candidate branch.')
  if (!reviewers.includes(pr.merged_by?.login)) {
    const reviews = list(`pulls/${pr.number}/reviews?per_page=100`)
    const approved = reviewers.some((login) => {
      const review = reviews.findLast(
        (review) =>
          review.user.login === login &&
          ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state),
      )
      return review?.state === 'APPROVED' && review.commit_id === pr.head.sha
    })
    if (!approved)
      throw new Error(
        'Tunglies or wonfen must merge the PR or approve its current head.',
      )
  }
  const sha = git('rev-parse', 'HEAD')
  if (sha !== pr.merge_commit_sha)
    throw new Error('Checkout does not match the PR merge commit.')
  git('merge-base', '--is-ancestor', sha, 'origin/main')
  validateVersions(tag)
  output({ release_tag: tag, source_sha: sha })
  summary(`Publishing ${tag} from merged PR #${pr.number} at ${sha}.`)
}

const commands = { prepare, 'create-pr': createPr, validate }
commands[process.argv[2]]()
