/**
 * haven — old-Reddit front end for P2P off-chain Haven voting.
 *
 * Zero-backend: static bundle, IndexedDB state, WebRTC vote gossip.
 * Every client validates every vote locally; tallies are computed from
 * the client's own validated set.
 */

import { ethers } from 'ethers'
import { VoteGSet } from './lib/gset.js'
import { VoteTransport } from './lib/transport.js'
import { createBoardSource, threadRootRef } from './lib/data.js'
import { connectWallet, getVoteSession } from './lib/wallet.js'
import { kvGet, kvSet, saveVotes, loadVotes, clearAll, storageMode } from './lib/store.js'
import { issueDemoAttestation, demoIssuerPublicKey } from './lib/haven/demo-issuer.js'
import { verifyAttestation, attestationMatchesGate, sha256Hex } from './lib/haven/attestation.js'
import { signVote } from './lib/haven/vote.js'
import { toChainVariant, chainLabel } from './lib/haven/gate-chains.js'

// --- state -------------------------------------------------------------------

const state = {
  mode: 'demo',
  config: {},
  wallet: null,
  boards: [],
  gates: {},
  threads: {},
  gset: new VoteGSet(),
  transport: null,
  subscriptions: null,
  sort: 'hot',
  view: 'frontpage', // frontpage | all
  walletExplicit: false,
}

const $ = (sel) => document.querySelector(sel)

// --- boot ---------------------------------------------------------------------

async function boot() {
  state.config = (await kvGet('config')) || {}
  state.mode = state.config.mode || 'demo'
  modeBadge()
  state.subscriptions = (await kvGet('subscriptions')) || null

  let source
  if (state.mode === 'demo') {
    source = createBoardSource('demo')
  } else {
    const live = await import('./live.js')
    source = live.createLiveSource({ rpcUrl: state.config.rpcUrl })
    state.liveSource = source
  }
  try {
    state.boards = await source.listBoards()
  } catch (err) {
    state.boards = []
    toast(err.message, true)
  }
  if (state.mode !== 'demo') {
    // Implicit boards: gates without a haven.board.def (spec slug rule).
    const custom = (await kvGet('customBoards')) || []
    for (const c of custom) {
      if (!state.boards.find((b) => b.slug === c.slug)) state.boards.push(c)
    }
  }
  for (const b of state.boards) {
    state.gates[b.slug] = { ...b.gate, board: b.slug }
    try {
      let threads
      if (b.isCustom && source.listThreadsForGate) {
        threads = await source.listThreadsForGate(b.gate)
      } else {
        threads = await source.listThreads(b.slug)
      }
      if (state.mode !== 'demo' && !b.isCustom && source.listPosts) {
        const posts = (await source.listPosts(b.slug).catch(() => [])) || []
        for (const th of threads) th.comments = posts.filter((p) => p.rootRef === th.id)
      }
      state.threads[b.slug] = threads
    } catch { state.threads[b.slug] = [] }
  }
  if (state.subscriptions === null) {
    state.subscriptions = new Set(state.boards.map((b) => b.slug))
    await persistSubs()
  } else {
    state.subscriptions = new Set(state.subscriptions)
  }

  // Persisted votes re-enter the set (they were valid at arrival;
  // expiry after arrival does not retract prior votes).
  const persisted = await loadVotes()
  for (const v of persisted) state.gset.add(v)

  state.wallet = await connectWallet()
  renderUser()

  startTransport()
  renderTabs()
  renderSide()
  route()
  window.addEventListener('hashchange', route)
}

function startTransport() {
  const issuerKey =
    state.mode === 'demo'
      ? demoIssuerPublicKey()
      : hexToUint8(state.config.issuerKeyHex) || demoIssuerPublicKey()
  state.transport = new VoteTransport({
    mode: state.mode,
    getGate: (slug) => state.gates[slug],
    issuerPublicKey: issuerKey,
    onVotes: (votes) => {
      let changed = false
      for (const { vote } of votes) {
        if (state.gset.add(vote)) changed = true
      }
      if (changed) {
        saveVotes(votes.map(({ id, vote }) => ({ __id: id, vote })))
        rerender()
      }
    },
    onRejected: (rejected, fromPeerId) => {
      if (fromPeerId !== null) {
        toast(`Rejected ${rejected.length} invalid vote${rejected.length > 1 ? 's' : ''} (${rejected[0]?.reason || 'malformed'})`, true)
      }
    },
    onPeers: (count) => {
      $('#peer-count').textContent = `${count} online`
    },
  })
  state.transport.setSnapshotProvider(() => state.gset.toArray())
  state.transport.start()
}

function hexToUint8(hex) {
  if (!hex) return null
  try {
    const clean = hex.startsWith('0x') ? hex.slice(2) : hex
    const bytes = new Uint8Array(clean.length / 2)
    for (let i = 0; i < clean.length; i += 2) bytes[i / 2] = parseInt(clean.slice(i, i + 2), 16)
    return bytes
  } catch { return null }
}

// --- routing ------------------------------------------------------------------

function route() {
  const hash = location.hash.replace(/^#/, '') || '/'
  const [path, query] = hash.split('?')
  const params = new URLSearchParams(query || '')
  state.sort = ['hot', 'new', 'top'].includes(params.get('sort')) ? params.get('sort') : 'hot'
  const parts = path.split('/').filter(Boolean)

  if (parts[0] === 'r' && parts[1] && parts[2] === 'comments' && parts[3]) {
    renderThread(parts[1], parts[3])
  } else if (parts[0] === 'r' && parts[1]) {
    renderBoard(parts[1])
  } else {
    if (params.get('view') === 'all') state.view = 'all'
    else if (params.has('view')) state.view = params.get('view')
    renderFrontpage()
  }
}

function rerender() {
  const hash = location.hash.replace(/^#/, '') || '/'
  const [path, query] = hash.split('?')
  const params = new URLSearchParams(query || '')
  const parts = path.split('/').filter(Boolean)
  if (parts[0] === 'r' && parts[1] && parts[2] === 'comments' && parts[3]) renderThread(parts[1], parts[3])
  else if (parts[0] === 'r' && parts[1]) renderBoard(parts[1])
  else renderFrontpage()
}

// --- rendering ----------------------------------------------------------------

function renderTabs() {
  const tabs = [
    { key: 'hot', label: 'hot' },
    { key: 'new', label: 'new' },
    { key: 'top', label: 'top' },
  ]
  const onFront = !location.hash.match(/^#\/r\//)
  if (onFront) tabs.push({ key: 'all', label: 'all boards', view: true })
  const menu = $('#tab-menu')
  menu.innerHTML = ''
  for (const t of tabs) {
    const a = document.createElement('a')
    a.href = t.view
      ? `#/?view=${t.key === 'all' ? 'all' : 'frontpage'}&sort=${state.sort}`
      : `#${currentPath()}?sort=${t.key}`
    a.textContent = t.label
    const selected = t.view
      ? (t.key === 'all') === (state.view === 'all')
      : state.sort === t.key
    if (selected) a.classList.add('selected')
    menu.appendChild(a)
  }
}

function currentPath() {
  const hash = location.hash.replace(/^#/, '') || '/'
  return hash.split('?')[0]
}

function allThreads(slugs) {
  const rows = []
  for (const slug of slugs) {
    const board = state.boards.find((b) => b.slug === slug)
    for (const th of state.threads[slug] || []) {
      rows.push({ board, thread: th, rootRef: threadRootRef(slug, th.id) })
    }
  }
  return rows
}

function sortRows(rows) {
  const scored = rows.map((r) => ({ ...r, score: state.gset.tally(r.board.slug, r.rootRef) }))
  const ts = (row) => (row.thread.createdAt > 0 ? row.thread.createdAt : row.thread.createdAtBlock || 0)
  if (state.sort === 'new') {
    scored.sort((a, b) => ts(b) - ts(a))
  } else if (state.sort === 'top') {
    scored.sort((a, b) => b.score - a.score || ts(b) - ts(a))
  } else {
    scored.sort((a, b) => hotness(b) - hotness(a) || ts(b) - ts(a))
  }
  return scored
}

function hotness(row) {
  const ageHours = (Date.now() / 1000 - row.thread.createdAt) / 3600
  return (row.score + 1) / Math.pow(ageHours + 2, 1.2)
}

function renderFrontpage() {
  state.view = 'frontpage'
  const slugs = state.view === 'all' ? state.boards.map((b) => b.slug) : [...state.subscriptions]
  renderListing(allThreads(slugs))
  renderSide()
  renderTabs()
}

function renderBoard(slug) {
  const board = state.boards.find((b) => b.slug === slug)
  if (!board) {
    $('#site-table').innerHTML = '<div class="empty-state">unknown board</div>'
    return
  }
  renderListing(allThreads([slug]), slug)
  renderSide(slug)
  renderTabs()
}

function renderListing(rows, boardSlug) {
  const sorted = sortRows(rows)
  const table = $('#site-table')
  table.innerHTML = ''
  if (!sorted.length) {
    table.innerHTML = '<div class="empty-state">nothing here yet</div>'
    return
  }
  sorted.forEach((row, i) => {
    table.appendChild(renderThingRow(row, i + 1, boardSlug))
  })
}

function renderThingRow({ board, thread, rootRef }, rank, boardSlug) {
  const thing = el('div', 'thing link')
  const voted = state.wallet ? state.gset.hasVoted(state.wallet.address, board.slug, rootRef) : false

  thing.appendChild(el('span', 'rank', String(rank)))

  const midcol = el('div', 'midcol')
  midcol.appendChild(arrow(board.slug, rootRef, voted))
  midcol.appendChild(el('span', 'score', String(state.gset.tally(board.slug, rootRef))))
  midcol.appendChild(downArrow())
  thing.appendChild(midcol)

  const entry = el('div', 'entry')
  const titleRow = el('div', 'title-row')
  const a = el('a', 'title')
  a.href = `#/r/${board.slug}/comments/${thread.id}`
  a.textContent = thread.title
  titleRow.appendChild(a)
  if (thread.domain) {
    const dom = el('span', 'domain', ` (${thread.domain})`)
    titleRow.appendChild(dom)
  }
  entry.appendChild(titleRow)

  const tagline = el('div', 'tagline')
  tagline.appendChild(document.createTextNode(`submitted ${threadLabel(thread)} by ${shortAddr(thread.submitter)}`))
  if (!boardSlug) {
    const bt = el('a', 'board-tag', board.slug)
    bt.href = `#/r/${board.slug}`
    bt.classList.add('subreddit-btn')
    tagline.appendChild(bt)
  }
  tagline.appendChild(document.createTextNode(' '))
  const cbtn = el('a', 'comments-btn', `${thread.comments.length} comment${thread.comments.length === 1 ? '' : 's'}`)
  cbtn.href = `#/r/${board.slug}/comments/${thread.id}`
  tagline.appendChild(cbtn)
  entry.appendChild(tagline)

  thing.appendChild(entry)
  return thing
}

async function renderThread(slug, threadId) {
  const board = state.boards.find((b) => b.slug === slug)
  const thread = (state.threads[slug] || []).find((t) => t.id === threadId)
  const table = $('#site-table')
  table.innerHTML = ''
  if (!board || !thread) {
    table.innerHTML = '<div class="empty-state">thread not found</div>'
    return
  }
  const rootRef = threadRootRef(slug, threadId)

  const thing = el('div', 'thing link')
  const midcol = el('div', 'midcol')
  const voted = state.wallet ? state.gset.hasVoted(state.wallet.address, slug, rootRef) : false
  midcol.appendChild(arrow(slug, rootRef, voted))
  midcol.appendChild(el('span', 'score', String(state.gset.tally(slug, rootRef))))
  midcol.appendChild(downArrow())
  thing.appendChild(midcol)

  const entry = el('div', 'entry')
  const titleRow = el('div', 'title-row')
  titleRow.appendChild(el('span', 'title', thread.title))
  entry.appendChild(titleRow)
  const tagline = el('div', 'tagline')
  tagline.textContent = `submitted ${threadLabel(thread)} by ${shortAddr(thread.submitter)}`
  entry.appendChild(tagline)
  thing.appendChild(entry)
  table.appendChild(thing)

  const body = el('div', 'post-body')
  if (state.mode !== 'demo' && state.liveSource?.getThreadPayload) {
    const p = await state.liveSource.getThreadPayload(threadId).catch(() => null)
    if (p?.sealed) {
      body.textContent = 'sealed — hold the gate token to decrypt (open in haven-dapp for v1/v4 unlocks)'
      body.classList.add('frosted')
    } else {
      body.textContent = p?.body || 'no text payload'
    }
  } else {
    body.textContent = thread.domain === 'self.haven'
      ? 'self post — no external link'
      : `linked to ${thread.domain}`
  }
  table.appendChild(body)

  const tree = el('div', 'comment-tree')
  tree.appendChild(el('h3', '', `${thread.comments.length} comments`))
  for (const c of thread.comments) {
    tree.appendChild(renderComment(slug, threadId, c))
  }
  table.appendChild(tree)
  renderSide(slug)
  renderTabs()
}

function renderComment(slug, threadId, c) {
  const rootRef = `${threadRootRef(slug, threadId)}/${c.id}`
  const div = el('div', 'comment')
  const midcol = el('div', 'midcol')
  const voted = state.wallet ? state.gset.hasVoted(state.wallet.address, slug, rootRef) : false
  midcol.appendChild(arrow(slug, rootRef, voted))
  midcol.appendChild(el('span', 'score', String(state.gset.tally(slug, rootRef))))
  midcol.appendChild(downArrow())
  div.appendChild(midcol)
  const entry = el('div', 'entry')
  const tagline = el('div', 'tagline')
  tagline.textContent = `${shortAddr(c.author)} ${threadLabel(c)}`
  entry.appendChild(tagline)
  const body = el('div')
  if (c.body === null || c.body === undefined) {
    body.textContent = 'sealed reply — hold the gate token to decrypt'
    body.classList.add('frosted')
  } else {
    body.textContent = c.body
  }
  entry.appendChild(body)
  div.appendChild(entry)
  return div
}

// --- sidebar ------------------------------------------------------------------

function renderSide(slug) {
  const side = $('#side')
  side.innerHTML = ''

  if (slug) {
    const board = state.boards.find((b) => b.slug === slug)
    if (board) {
      side.appendChild(box('about this board', (b) => {
        b.appendChild(kv('gate token', board.gate.tokenAddress))
        b.appendChild(kv('chain', chainLabel(toChainVariant(board.gate.gate_chain))))
        b.appendChild(kv('threshold', `${board.gate.gate_threshold} tokens`))
        const votes = boardVoteCount(slug)
        b.appendChild(kv('relayed votes', String(votes)))
        const btn = el('button', 'subscribe-btn' + (state.subscriptions.has(slug) ? ' subscribed' : ''),
          state.subscriptions.has(slug) ? 'unsubscribe' : 'subscribe')
        btn.onclick = () => toggleSubscribe(slug)
        b.appendChild(btn)
      }))
      side.appendChild(box('voting here', (b) => {
        b.appendChild(el('div', 'status',
          'Upvotes are signed by a session key certified by your wallet (EIP-712), attach your own token-holding attestation, and gossip peer-to-peer over WebRTC. Tallies are computed locally from validated votes. Downvotes are disabled — the grow-only vote set has no retraction.'))
      }))
    }
  }

  side.appendChild(box('boards', (b) => {
    for (const board of state.boards) {
      const row = el('div', 'status')
      const link = el('a', '', board.slug)
      link.href = `#/r/${board.slug}`
      row.appendChild(link)
      const n = el('span', '', ` — ${boardVoteCount(board.slug)} votes`)
      n.style.color = '#888'
      n.style.fontSize = '10px'
      row.appendChild(n)
      b.appendChild(row)
    }
  }))

  side.appendChild(box('status', (b) => {
    b.appendChild(kv('mode', state.mode === 'demo' ? 'DEMO — labeled simulation' : 'live'))
    b.appendChild(kv('wallet', state.wallet ? shortAddr(state.wallet.address) + (state.wallet.isDemo ? ' (demo)' : '') : 'not connected'))
    b.appendChild(kv('valid votes', String(state.gset.toArray().length)))
    b.appendChild(kv('storage', storageMode === 'indexeddb' ? 'IndexedDB' : storageMode === 'memory' ? 'in-memory only' : 'detecting'))
  }))

  if (state.mode !== 'demo') {
    side.appendChild(box('add board by gate', (b) => {
      b.appendChild(el('div', 'status', 'A gate without a haven.board.def is still a board (implicit slug rule). Threads come from haven.*.full media records matching the gate.'))
      const form = el('form', 'add-board-form')
      const token = el('input', 'add-board-input')
      token.placeholder = 'gate token address (0x…)'
      token.required = true
      const chain = el('select', 'add-board-input')
      for (const [id, name] of [[1, 'ethereum (1)'], [8453, 'base (8453)'], [59144, 'linea (59144)'], [2741, 'abstract (2741)']]) {
        const opt = el('option', '', name)
        opt.value = String(id)
        chain.appendChild(opt)
      }
      const threshold = el('input', 'add-board-input')
      threshold.type = 'number'
      threshold.min = '1'
      threshold.value = '1'
      threshold.required = true
      const btn = el('button', 'subscribe-btn', 'add board')
      btn.type = 'submit'
      form.appendChild(token)
      form.appendChild(chain)
      form.appendChild(threshold)
      form.appendChild(btn)
      form.onsubmit = async (e) => {
        e.preventDefault()
        await addBoardByGate(token.value.trim(), Number(chain.value), Number(threshold.value))
      }
      b.appendChild(form)
    }))
  }
}

async function addBoardByGate(tokenAddress, gateChain, gateThreshold) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) {
    toast('invalid token address', true)
    return
  }
  const slug = `g.${gateChain}.${tokenAddress.slice(2, 14).toLowerCase()}`
  if (state.boards.find((b) => b.slug === slug)) {
    toast('board already added')
  } else {
    const board = {
      slug,
      title: slug,
      gate: { tokenAddress, gate_chain: gateChain, gate_threshold: gateThreshold },
      description: 'implicit board — gate without a haven.board.def',
      isCustom: true,
    }
    const custom = (await kvGet('customBoards')) || []
    custom.push(board)
    await kvSet('customBoards', custom)
    state.boards.push(board)
    state.gates[slug] = { ...board.gate, board: slug }
    state.threads[slug] = []
    if (state.liveSource?.listThreadsForGate) {
      try { state.threads[slug] = await state.liveSource.listThreadsForGate(board.gate) } catch { /* empty */ }
    }
    state.subscriptions.add(slug)
    await persistSubs()
    toast(`added ${slug}`)
    location.hash = `#/r/${slug}`
    rerender()
  }
}

function boardVoteCount(slug) {
  let n = 0
  for (const id of state.gset.byDedupeKey.values()) {
    const v = state.gset.votes.get(id)
    if (v.board === slug) n++
  }
  return n
}

function box(title, fill) {
  const spacer = el('div', 'spacer')
  const h = el('h2', '', title)
  spacer.appendChild(h)
  fill(spacer)
  return spacer
}

function kv(k, v) {
  const row = el('div', 'value')
  const label = el('span', '', `${k}: `)
  label.style.color = '#888'
  row.appendChild(label)
  row.appendChild(document.createTextNode(v))
  return row
}

async function toggleSubscribe(slug) {
  if (state.subscriptions.has(slug)) state.subscriptions.delete(slug)
  else state.subscriptions.add(slug)
  await persistSubs()
  renderSide(slug)
}

async function persistSubs() {
  await kvSet('subscriptions', [...state.subscriptions])
}

// --- voting -------------------------------------------------------------------

function arrow(board, rootRef, voted) {
  const a = el('div', 'arrow ' + (voted ? 'upmod' : 'up'))
  a.title = voted ? 'upvoted' : 'upvote'
  a.setAttribute('role', 'button')
  a.onclick = () => upvote(board, rootRef).catch((e) => toast(e.message, true))
  return a
}

function downArrow() {
  const d = el('div', 'arrow down')
  d.title = 'downvotes disabled — grow-only vote set'
  return d
}

async function upvote(boardSlug, rootRef) {
  const gate = state.gates[boardSlug]
  if (!gate) throw new Error('unknown board')

  if (state.gset.hasVoted(state.wallet.address, boardSlug, rootRef)) {
    toast('already upvoted — one vote per wallet per item')
    return
  }

  const session = await getVoteSession({ board: boardSlug, gateChainId: gate.gate_chain, wallet: state.wallet })
  const attestation = await ensureAttestation(boardSlug, gate, state.wallet)

  const vote = {
    v: 1,
    board: boardSlug,
    rootRef,
    voterAddress: state.wallet.address,
    attestation,
    sessionPubKey: session.sessionPubKey,
    certIssuedAt: session.certIssuedAt,
    sessionCert: session.sessionCert,
    voteSig: '',
    createdAt: Math.floor(Date.now() / 1000),
  }
  const { voteSig } = await signVote(vote, new ethers.SigningKey(session.sessionKey))
  vote.voteSig = voteSig

  const res = state.transport.publishVote(vote)
  if (!res.added.length) {
    const reason = res.rejected[0]?.reason || 'rejected'
    throw new Error(`vote rejected: ${reason}`)
  }
  toast('upvoted — gossiping to peers')
}

/**
 * Get a valid attestation for this wallet + board gate. Demo mode
 * issues one from the pinned demo issuer; live mode requires the
 * Haven-AOL canister (attest_holding) — not wired in this build.
 */
async function ensureAttestation(boardSlug, gate, wallet) {
  const cacheKey = `attest:${state.mode}:${boardSlug}:${wallet.address.toLowerCase()}`
  const cached = await kvGet(cacheKey)
  const issuerKey = state.mode === 'demo' ? demoIssuerPublicKey() : hexToUint8(state.config.issuerKeyHex)
  if (cached && issuerKey && verifyAttestation(cached, issuerKey) && attestationMatchesGate(cached, gate, wallet.address)) {
    return cached
  }
  if (state.mode !== 'demo') {
    throw new Error('live attestation requires the Haven-AOL canister — configure an issuer key or use demo mode')
  }
  const attestation = issueDemoAttestation({
    evmAddress: wallet.address,
    chain: toChainVariant(gate.gate_chain),
    tokenAddress: gate.tokenAddress,
    threshold: gate.gate_threshold,
    balanceAtCheck: gate.gate_threshold,
    cidHash: sha256Hex(`HAVEN_VOTE_IDENTITY:${wallet.address.toLowerCase()}`),
  })
  await kvSet(cacheKey, attestation)
  return attestation
}

// --- misc UI ------------------------------------------------------------------

function renderUser() {
  const user = $('#user')
  user.innerHTML = ''
  if (state.wallet) {
    user.appendChild(document.createTextNode(shortAddr(state.wallet.address) + (state.wallet.isDemo ? ' (demo wallet)' : '')))
  }
  const btn = el('button', '', state.wallet && !state.wallet.isDemo ? 'switch' : 'connect wallet')
  btn.onclick = async () => {
    const w = await connectWallet()
    state.wallet = w
    renderUser()
    rerender()
  }
  user.appendChild(btn)
}

function el(tag, cls, text) {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

function shortAddr(a) {
  return a.slice(0, 6) + '…' + a.slice(-4)
}

function timeAgo(unixSec) {
  const mins = Math.max(1, Math.floor(Date.now() / 1000 - unixSec) / 60)
  if (mins < 60) return `${Math.floor(mins)} minute${Math.floor(mins) === 1 ? '' : 's'} ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

/** Label for a thread/comment row: wall-clock for demo data, block number for live entities. */
function threadLabel(item) {
  if (item.createdAt > 0) return timeAgo(item.createdAt)
  return `at block ${item.createdAtBlock || '?'}`
}

let toastTimer = null
function toast(msg, isError = false) {
  const t = $('#toast')
  t.textContent = msg
  t.classList.toggle('error', isError)
  t.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.classList.remove('show'), 3500)
}

// --- settings -----------------------------------------------------------------

$('#settings-btn').onclick = () => {
  $('#set-mode').value = state.mode
  $('#set-rpc').value = state.config.rpcUrl || ''
  $('#set-canister').value = state.config.canisterId || 'gny6k-fqaaa-aaaab-ag3ra-cai'
  $('#settings-dialog').showModal()
}

$('#settings-form').onsubmit = async (e) => {
  e.preventDefault()
  state.config = {
    mode: $('#set-mode').value,
    rpcUrl: $('#set-rpc').value.trim(),
    canisterId: $('#set-canister').value.trim(),
  }
  await kvSet('config', state.config)
  if (state.transport) state.transport.stop()
  location.reload()
}

$('#clear-data').onclick = async () => {
  await clearAll()
  location.reload()
}

const modeBadge = () => {
  const badge = $('#mode-badge')
  badge.textContent = state.mode === 'demo' ? 'DEMO' : 'LIVE'
  badge.classList.toggle('live', state.mode !== 'demo')
}

// Debug/QA hook — not used by the UI.
window.__haven = state
window.__upvote = (board, rootRef) => upvote(board, rootRef)

boot()
