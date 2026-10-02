// The chat page: talks to one Claude Code session on the server, draws its
// replies, tools and questions as they stream in, and sends what you type.

import { marked } from '/vendor/marked.js'
import DOMPurify from '/vendor/purify.js'

const $ = id => document.getElementById(id)

const els = {
  app: document.querySelector('.app'),
  sidebar: $('sidebar'),
  scrim: $('scrim'),
  toggleSidebar: $('toggle-sidebar'),
  newChat: $('new-chat'),
  folderForm: $('folder-form'),
  folder: $('folder'),
  folderError: $('folder-error'),
  sessions: $('sessions'),
  banner: $('banner'),
  scroller: $('scroller'),
  messages: $('messages'),
  todos: $('todos'),
  composer: $('composer'),
  suggest: $('suggest'),
  attachments: $('attachments'),
  input: $('input'),
  attach: $('attach'),
  file: $('file'),
  mode: $('mode'),
  model: $('model'),
  effort: $('effort'),
  status: $('status'),
  send: $('send'),
  plan: $('plan'),
  toast: $('toast'),
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_IMAGES = 5
const MAX_PREVIEW_LINES = 400

const TOOL_NAMES = {
  Read: 'Read',
  Write: 'Write',
  Edit: 'Edit',
  MultiEdit: 'Edit',
  NotebookEdit: 'Edit notebook',
  Bash: 'Run',
  BashOutput: 'Check output',
  KillShell: 'Stop command',
  Glob: 'Find files',
  Grep: 'Search',
  LS: 'List',
  WebFetch: 'Fetch',
  WebSearch: 'Web search',
  Task: 'Agent',
  Agent: 'Agent',
  TodoWrite: 'Plan',
  Skill: 'Skill',
  AskUserQuestion: 'Question',
  ExitPlanMode: 'Plan ready',
}

const EFFORT_WORDS = { low: 'Low effort', medium: 'Medium effort', high: 'High effort', xhigh: 'Extra high effort', max: 'Max effort' }

const ERROR_WORDS = {
  authentication_failed: 'Claude Code is not signed in. Run `claude` in a terminal once and sign in.',
  billing_error: 'There is a billing problem with your account.',
  rate_limit: 'You have hit your usage limit for now. Try again later.',
  invalid_request: 'Claude could not accept that request.',
  server_error: 'Claude had a server problem. Try again.',
  max_output_tokens: 'The reply was too long and got cut off.',
}

const STARTERS = [
  'Explain what this project does',
  'Find a bug and fix it',
  'What changed recently in git?',
  'Write tests for the most important file',
]

marked.setOptions({ gfm: true })

DOMPurify.addHook('afterSanitizeAttributes', node => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

// Session state

let chat = null
let source = null
let info = null
let state = { mode: 'default', model: 'default', effort: null, activeModel: null }
let isBusy = false
let isClosed = false
let busySinceMs = 0
let statusText = null
let folder = ''
let attachments = []
let view = freshView()
let reopenedAtMs = 0
let suggestion = null

function freshView() {
  return {
    tools: new Map(),
    drafts: new Map(),
    finals: new Map(),
    cards: new Map(),
    subagents: new Map(),
    streamMessageId: null,
    hasEmpty: false,
  }
}

// Small helpers

function h(tag, className, text) {
  const el = document.createElement(tag)
  if (className) el.className = className
  if (text !== undefined) el.textContent = text
  return el
}

function remember(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(`fin-code.${key}`)
    localStorage.setItem(`fin-code.${key}`, value)
  } catch {}
  return null
}

async function api(path, body) {
  const init = body === undefined
    ? {}
    : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Addon-Manager': '1' }, body: JSON.stringify(body) }
  const res = await fetch(path, init)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
  return data
}

let toastTimer = null

function toast(text) {
  els.toast.textContent = text
  els.toast.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (els.toast.hidden = true), 6000)
}

function markdown(text) {
  const el = h('div', 'md')
  el.innerHTML = DOMPurify.sanitize(marked.parse(text ?? ''))
  enhanceCode(el)
  return el
}

// Wraps code blocks so each gets a copy button.
function enhanceCode(root) {
  for (const pre of root.querySelectorAll('pre')) {
    if (pre.parentElement.classList.contains('code')) continue
    const box = h('div', 'code')
    const copy = h('button', 'copy', 'Copy')
    copy.type = 'button'
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(pre.textContent)
        copy.textContent = 'Copied'
        setTimeout(() => (copy.textContent = 'Copy'), 1500)
      } catch {
        toast("Couldn't copy. Select the text and copy it yourself.")
      }
    })
    pre.replaceWith(box)
    box.append(pre, copy)
  }
}

function relPath(file) {
  if (typeof file !== 'string') return ''
  const norm = file.replaceAll('\\', '/')
  const base = (chat?.cwd ?? '').replaceAll('\\', '/').replace(/\/$/, '')
  if (base && norm.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return norm.slice(base.length + 1)
  return norm
}

function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 172800) return 'yesterday'
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function duration(ms) {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

// Keeps the view pinned to the bottom while you are reading the newest part.
function isNearBottom() {
  const { scrollHeight, scrollTop, clientHeight } = els.scroller
  return scrollHeight - scrollTop - clientHeight < 140
}

function stickAfter(change) {
  const near = isNearBottom()
  change()
  if (near) els.scroller.scrollTop = els.scroller.scrollHeight
}

function append(el, parent = els.messages) {
  if (parent === els.messages) dropEmpty()
  stickAfter(() => parent.append(el))
  return el
}

// Opening a chat

async function openChat(target) {
  source?.close()
  source = null
  chat = null
  resetView()
  els.messages.replaceChildren(h('p', 'loading', 'Starting Claude Code…'))
  hideBanner()

  try {
    const { id, cwd } = await api('/api/chat/open', target)
    chat = { id, cwd, hasMessages: Boolean(target.sessionId) }

    if (cwd !== folder) setFolder(cwd)
    history.replaceState(null, '', target.sessionId ? `#${id}` : location.pathname)

    connect()
    renderSessions()
  } catch (error) {
    els.messages.replaceChildren(errorBox(error.message))
    if (target.sessionId) history.replaceState(null, '', location.pathname)
  }

  closeSidebar()
}

function connect() {
  const id = chat.id
  source = new EventSource(`/api/chat/events?id=${encodeURIComponent(id)}`)

  source.onmessage = message => handle(JSON.parse(message.data))
  source.onopen = () => hideBanner()
  source.onerror = () => {
    if (!source || source.readyState !== EventSource.CLOSED) {
      showBanner('Reconnecting to fin-code…')
      return
    }

    // The server restarted or closed this chat while it sat idle: reopen it
    // from its saved transcript, once, if there is anything to reopen.
    if (chat?.id === id && chat.hasMessages && Date.now() - reopenedAtMs > 10_000) {
      reopenedAtMs = Date.now()
      openChat({ sessionId: id })
    } else {
      showBanner("Lost the connection to fin-code. Check that its window is still open, then reload.", 'Reload', () => location.reload())
    }
  }
}

function resetView() {
  view = freshView()
  isBusy = false
  isClosed = false
  statusText = null
  els.todos.hidden = true
  els.todos.replaceChildren()
  renderStatus()
}

function setFolder(value) {
  folder = value
  els.folder.value = value
  remember('folder', value)
}

// Events from the server

function handle(event) {
  switch (event.kind) {
    case 'hello': return onHello(event)
    case 'info':
      info = event.info
      state = event.state
      return renderControls()
    case 'state':
      state = event.state
      return renderControls()
    case 'busy': return setBusy(event.isBusy)
    case 'status':
      statusText = event.status
      return renderStatus()
    case 'closed':
      isClosed = true
      setBusy(false)
      renderControls()
      return append(closedNote())
    case 'user': return addUser(event)
    case 'stream': return onStream(event.event)
    case 'sdk': return onSdk(event.message)
    case 'permission': return addCard(event)
    case 'resolved': return resolveCard(event)
    case 'history-end': return settleHistory()
    case 'error': return append(errorBox(event.message))
  }
}

function onHello(event) {
  resetView()
  els.messages.replaceChildren()
  info = event.info ?? info
  state = event.state
  isClosed = event.isClosed
  chat.cwd = event.cwd
  setBusy(event.isBusy)
  renderControls()
  showEmpty()
  requestAnimationFrame(() => (els.scroller.scrollTop = els.scroller.scrollHeight))
}

function showEmpty() {
  const empty = h('div', 'empty')
  empty.append(h('h1', '', 'What should we work on?'))

  const p = h('p')
  p.append('Claude can read and change files in ', h('code', '', chat.cwd), ', run commands, and use your add-ons. It asks before doing anything risky.')
  empty.append(p)

  const starters = h('div', 'starters')
  for (const text of STARTERS) {
    const button = h('button', '', text)
    button.type = 'button'
    button.addEventListener('click', () => {
      els.input.value = text
      autosize()
      els.input.focus()
    })
    starters.append(button)
  }
  empty.append(starters)

  els.messages.append(empty)
  view.hasEmpty = true
}

function dropEmpty() {
  if (view.hasEmpty) {
    els.messages.querySelector('.empty')?.remove()
    view.hasEmpty = false
  }
}

function addUser({ text, images = [] }) {
  const el = h('div', 'msg-user')

  if (images.length) {
    const row = h('div', 'images')
    for (const image of images) {
      const img = h('img')
      img.src = `data:${image.mediaType};base64,${image.data}`
      img.alt = 'Attached image'
      row.append(img)
    }
    el.append(row)
  }

  if (text) el.append(document.createTextNode(text))
  append(el)

  if (chat && !chat.hasMessages) {
    chat.hasMessages = true
    history.replaceState(null, '', `#${chat.id}`)
  }
}

// Streaming: a draft for each text or thinking block, replaced in place by
// the finished block when it arrives.
function onStream(event) {
  if (event.type === 'message_start') {
    view.streamMessageId = event.message.id
    return
  }

  const key = `${view.streamMessageId}:${event.index}`

  if (event.type === 'content_block_start') {
    const type = event.content_block?.type
    if ((view.finals.get(view.streamMessageId) ?? 0) > event.index) return

    if (type === 'text') {
      const el = h('div', 'msg-text md streaming')
      view.drafts.set(key, { el, type, text: '' })
      append(el)
    } else if (type === 'thinking') {
      const el = thinkingBlock('', true)
      view.drafts.set(key, { el, type, text: '' })
      append(el)
    }
    return
  }

  if (event.type === 'content_block_delta') {
    const draft = view.drafts.get(key)
    if (!draft) return

    if (event.delta.type === 'text_delta') draft.text += event.delta.text
    else if (event.delta.type === 'thinking_delta') draft.text += event.delta.thinking
    else return

    if (!draft.isScheduled) {
      draft.isScheduled = true
      requestAnimationFrame(() => {
        draft.isScheduled = false
        stickAfter(() => {
          if (draft.type === 'text') draft.el.innerHTML = DOMPurify.sanitize(marked.parse(draft.text))
          else draft.el.querySelector('.body').textContent = draft.text
        })
      })
    }
  }
}

function onSdk(message) {
  if (message.type === 'assistant') return onAssistant(message)
  if (message.type === 'user') return onToolResults(message)
  if (message.type === 'result') return onResult(message)

  if (message.type === 'system' && message.subtype === 'compact_boundary') {
    append(h('div', 'note divider', 'Earlier messages were summarized to save space'))
  } else if (message.type === 'system' && message.subtype === 'local_command_output') {
    const box = h('div', 'local-output')
    box.append(markdown(message.content))
    append(box)
  }
}

function onAssistant(message) {
  const msg = message.message
  const parentId = message.parent_tool_use_id
  const blocks = Array.isArray(msg?.content) ? msg.content : []

  if (parentId) {
    const box = subagentBox(parentId)
    for (const block of blocks) {
      if (block.type === 'text' && block.text.trim()) append(markdown(block.text), box)
      else if (block.type === 'tool_use') append(toolRow(block), box)
    }
    return
  }

  const first = view.finals.get(msg.id) ?? 0
  view.finals.set(msg.id, first + blocks.length)

  blocks.forEach((block, i) => {
    const key = `${msg.id}:${first + i}`
    const draft = view.drafts.get(key)
    const el = blockElement(block)

    view.drafts.delete(key)
    if (draft && el) draft.el.replaceWith(el)
    else if (draft) draft.el.remove()
    else if (el) append(el)
  })

  if (message.error) {
    append(errorBox(ERROR_WORDS[message.error] ?? `Claude ran into a problem (${message.error}).`))
  }
}

function blockElement(block) {
  if (block.type === 'text') {
    if (!block.text.trim()) return null
    const el = markdown(block.text)
    el.classList.add('msg-text')
    return el
  }

  if (block.type === 'thinking') return block.thinking?.trim() ? thinkingBlock(block.thinking, false) : null
  if (block.type === 'tool_use') return toolRow(block)
  return null
}

function thinkingBlock(text, isLive) {
  const el = h('details', 'thinking')
  el.append(h('summary', '', isLive ? 'Thinking…' : 'Thought for a moment'), h('div', 'body', text))
  return el
}

// Tool rows: one line saying what Claude did, with the details inside.

function toolName(name) {
  if (TOOL_NAMES[name]) return TOOL_NAMES[name]
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  return mcp ? `${mcp[1]} · ${mcp[2]}` : name
}

function toolTarget(name, input = {}) {
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return relPath(input.file_path)
    case 'NotebookEdit': return relPath(input.notebook_path)
    case 'Bash': return input.description || input.command
    case 'Glob': return input.pattern
    case 'Grep': return `${input.pattern}${input.path ? `  in ${relPath(input.path)}` : ''}`
    case 'LS': return relPath(input.path)
    case 'WebFetch': return input.url
    case 'WebSearch': return input.query
    case 'Task':
    case 'Agent': return input.description || input.subagent_type
    case 'TodoWrite': return 'Updated the plan'
    case 'Skill': return input.skill || input.command
    case 'AskUserQuestion': return input.questions?.[0]?.question
    default: {
      const first = Object.values(input).find(value => typeof value === 'string')
      return first ?? ''
    }
  }
}

function toolRow(block) {
  const { id, name, input = {} } = block
  const row = h('details', 'tool')
  row.dataset.status = 'running'

  const summary = h('summary')
  summary.append(h('span', 'dot'), h('span', 'name', toolName(name)), h('span', 'target', toolTarget(name, input) ?? ''))

  const body = h('div', 'tool-body')
  const diff = diffOfTool(name, input)

  if (diff) {
    const extra = h('span', 'extra')
    extra.append(h('span', 'plus', `+${diff.added}`), h('span', 'minus', `−${diff.removed}`))
    summary.append(extra)
    body.append(diff.el)
    row.open = diff.added + diff.removed <= 40
  } else if (name === 'Bash') {
    body.append(labeled('Command', h('pre', '', input.command ?? '')))
  } else if (name === 'TodoWrite') {
    renderTodos(input.todos)
  } else if (!['Read', 'Task', 'Agent', 'AskUserQuestion', 'ExitPlanMode'].includes(name)) {
    body.append(labeled('Details', h('pre', '', JSON.stringify(input, null, 2))))
  }

  const chev = h('span', 'chev', '›')
  summary.append(chev)
  row.append(summary, body)

  if (!body.childElementCount) body.hidden = true
  view.tools.set(id, { row, body, name, summary })
  return row
}

function labeled(label, el) {
  const box = h('div')
  box.append(h('div', 'label', label), el)
  return box
}

function subagentBox(parentId) {
  let box = view.subagents.get(parentId)
  if (box) return box

  box = h('div', 'subagent')
  view.subagents.set(parentId, box)

  const tool = view.tools.get(parentId)
  if (tool) {
    tool.body.hidden = false
    tool.body.append(labeled('Steps', box))
  } else {
    append(box)
  }
  return box
}

function onToolResults(message) {
  const blocks = Array.isArray(message.message?.content) ? message.message.content : []

  for (const block of blocks) {
    if (block.type !== 'tool_result') continue
    const tool = view.tools.get(block.tool_use_id)
    if (!tool) continue

    tool.row.dataset.status = block.is_error ? 'error' : 'done'
    const text = resultText(block.content)

    if (!text) continue

    if (block.is_error) {
      tool.body.append(labeled('Problem', h('pre', 'error', text)))
    } else if (tool.name === 'Task' || tool.name === 'Agent') {
      tool.body.append(labeled('Result', markdown(text)))
    } else if (['Bash', 'BashOutput', 'Grep', 'Glob', 'LS', 'WebSearch', 'WebFetch'].includes(tool.name) || tool.name.startsWith('mcp__')) {
      tool.body.append(labeled('Output', h('pre', '', clip(text))))
    } else if (tool.name === 'Read') {
      const lines = text.split('\n').length
      tool.summary.querySelector('.chev').before(h('span', 'extra', `${lines} lines`))
      tool.body.append(labeled('Contents', h('pre', '', clip(text))))
    } else {
      continue
    }

    tool.body.hidden = false
  }
}

function resultText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(part => (part.type === 'text' ? part.text : part.type === 'image' ? '[image]' : '')).join('\n')
}

function clip(text, max = 20_000) {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text
}

function onResult(message) {
  setBusy(false)

  for (const { row } of view.tools.values()) {
    if (row.dataset.status === 'running' || row.dataset.status === 'waiting') row.dataset.status = 'error'
  }

  if (message.subtype === 'success' && message.local_command && message.result) {
    const box = h('div', 'local-output')
    box.append(markdown(message.result))
    append(box)
    return
  }

  const end = h('div', 'turn-end')

  if (message.subtype === 'success' && !message.is_error) {
    end.textContent = `Done in ${duration(message.duration_ms)}`
  } else {
    end.classList.add('error')
    const reasons = {
      error_max_turns: 'Stopped: it took too many steps.',
      error_max_budget_usd: 'Stopped: it reached the spending limit.',
      error_during_execution: 'Stopped.',
    }
    end.textContent = reasons[message.subtype] ?? (message.result || 'Stopped.')
    if (message.errors?.length) end.textContent += ` ${message.errors.join(' ')}`
  }

  append(end)
  scheduleSessionsRefresh()
}

// Old chats have no result messages, so their unanswered tools just stop.
function settleHistory() {
  for (const { row } of view.tools.values()) {
    if (row.dataset.status === 'running') row.dataset.status = 'done'
  }
}

// Diffs

function diffOfTool(name, input) {
  if (name === 'Edit' && typeof input.old_string === 'string') {
    return diffView([{ file: input.file_path, old: input.old_string, new: input.new_string ?? '' }])
  }
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    return diffView(input.edits.map(edit => ({ file: input.file_path, old: edit.old_string ?? '', new: edit.new_string ?? '' })))
  }
  if (name === 'Write' && typeof input.content === 'string') {
    return diffView([{ file: input.file_path, old: '', new: input.content, isNew: true }])
  }
  return null
}

function diffView(changes) {
  const el = h('div')
  let added = 0
  let removed = 0

  for (const [i, change] of changes.entries()) {
    const ops = change.isNew ? change.new.split('\n').map(line => ['+', line]) : lineDiff(change.old, change.new)
    const box = h('div', 'diff')
    let shown = 0

    for (const [sign, text] of ops) {
      if (sign === '+') added++
      if (sign === '-') removed++
      if (shown++ >= MAX_PREVIEW_LINES) continue

      const line = h('div', `line ${sign === '+' ? 'add' : sign === '-' ? 'del' : 'ctx'}`)
      line.append(h('span', 'sign', sign === ' ' ? '' : sign), h('span', 'text', text))
      box.append(line)
    }

    if (shown > MAX_PREVIEW_LINES) box.append(h('div', 'gap', `… ${shown - MAX_PREVIEW_LINES} more lines`))
    if (changes.length > 1) el.append(h('div', 'diff-file', `Change ${i + 1} of ${changes.length}`))
    el.append(box)
  }

  return { el, added, removed }
}

// Line diff: common start and end kept as context, the middle by LCS.
function lineDiff(before, after) {
  const a = before.split('\n')
  const b = after.split('\n')
  const context = 3

  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++

  let endA = a.length - 1
  let endB = b.length - 1
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--
    endB--
  }

  const midA = a.slice(start, endA + 1)
  const midB = b.slice(start, endB + 1)
  const middle = midA.length * midB.length <= 250_000
    ? lcsOps(midA, midB)
    : [...midA.map(line => ['-', line]), ...midB.map(line => ['+', line])]

  return [
    ...a.slice(Math.max(0, start - context), start).map(line => [' ', line]),
    ...middle,
    ...a.slice(endA + 1, endA + 1 + context).map(line => [' ', line]),
  ]
}

function lcsOps(a, b) {
  const rows = a.length + 1
  const cols = b.length + 1
  const table = new Uint32Array(rows * cols)

  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * cols + j] = a[i] === b[j]
        ? table[(i + 1) * cols + j + 1] + 1
        : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1])
    }
  }

  const ops = []
  let i = 0
  let j = 0

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push([' ', a[i]])
      i++
      j++
    } else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) {
      ops.push(['-', a[i++]])
    } else {
      ops.push(['+', b[j++]])
    }
  }

  while (i < a.length) ops.push(['-', a[i++]])
  while (j < b.length) ops.push(['+', b[j++]])
  return ops
}

// Cards: Claude asking for permission, asking a question, or showing a plan.

function addCard(event) {
  const tool = event.toolUseId ? view.tools.get(event.toolUseId) : null
  if (tool) tool.row.dataset.status = 'waiting'

  const card = event.toolName === 'AskUserQuestion'
    ? questionCard(event)
    : event.toolName === 'ExitPlanMode'
      ? planCard(event)
      : permissionCard(event)

  view.cards.set(event.requestId, { card, event })
  append(card)
  renderStatus()
}

function permissionCard(event) {
  const { requestId, toolName: name, input } = event
  const card = h('div', 'card')

  card.append(h('h3', '', event.title || `Claude wants to use ${event.displayName || toolName(name)}`))
  if (event.description) card.append(h('p', 'sub', event.description))

  const diff = diffOfTool(name, input)
  if (diff) {
    if (input.file_path) card.append(h('div', 'diff-file', relPath(input.file_path)))
    card.append(diff.el)
  } else if (name === 'Bash') {
    card.append(h('pre', 'diff', input.command ?? ''))
    card.lastChild.style.padding = '8px 10px'
    card.lastChild.style.whiteSpace = 'pre-wrap'
  } else if (!event.title) {
    card.append(h('pre', 'diff', JSON.stringify(input, null, 2)))
    card.lastChild.style.padding = '8px 10px'
    card.lastChild.style.whiteSpace = 'pre-wrap'
  }

  if (event.decisionReason) card.append(h('p', 'reason', event.decisionReason))

  const actions = h('div', 'actions')
  const allow = button('Allow', 'primary', () => answer(requestId, { kind: 'allow' }))
  actions.append(allow)

  if (event.alwaysAllow.length) {
    const always = button('', 'ghost always', () => answer(requestId, { kind: 'always' }))
    always.append('Always allow', h('small', '', event.alwaysAllow.map(({ rule, where }) => `${rule} ${where}`).join(', ')))
    actions.append(always)
  }

  const deny = button('Deny', 'ghost danger', () => answer(requestId, { kind: 'deny' }))
  const instead = button('Tell Claude what to do instead', 'quiet', () => {
    feedback.hidden = false
    feedback.querySelector('input').focus()
  })
  actions.append(deny, instead)

  const feedback = feedbackRow('What should Claude do instead?', text => answer(requestId, { kind: 'deny', message: text }))
  card.append(actions, feedback)

  requestAnimationFrame(() => (event.isDefaultNo ? deny : allow).focus({ preventScroll: true }))
  return card
}

function questionCard(event) {
  const { requestId, input } = event
  const card = h('div', 'card')
  const picks = new Map()

  card.append(h('h3', '', input.questions.length > 1 ? 'Claude has some questions' : 'Claude has a question'))

  for (const q of input.questions) {
    const block = h('div', 'question')
    if (q.header) block.append(h('span', 'chip', q.header))
    block.append(h('div', 'q', q.question))

    const options = h('div', 'options')
    const chosen = new Set()
    picks.set(q.question, { chosen, other: '' })

    for (const option of q.options) {
      const choice = h('button', 'option')
      choice.type = 'button'
      choice.setAttribute('aria-pressed', 'false')
      choice.append(option.label)
      if (option.description) choice.append(h('small', '', option.description))
      choice.addEventListener('click', () => {
        if (!q.multiSelect) {
          chosen.clear()
          options.querySelectorAll('.option').forEach(other => other.setAttribute('aria-pressed', 'false'))
        }
        if (chosen.has(option.label)) chosen.delete(option.label)
        else chosen.add(option.label)
        choice.setAttribute('aria-pressed', String(chosen.has(option.label)))
        refresh()
      })
      options.append(choice)
    }

    const other = h('input', 'other')
    other.placeholder = 'Or type your own answer'
    other.addEventListener('input', () => {
      picks.get(q.question).other = other.value.trim()
      refresh()
    })

    block.append(options, other)
    card.append(block)
  }

  const actions = h('div', 'actions')
  const submit = button('Send answers', 'primary', () => {
    const answers = {}
    for (const [question, { chosen, other }] of picks) {
      answers[question] = [...chosen, ...(other ? [other] : [])].join(', ')
    }
    answer(requestId, { kind: 'answers', answers })
  })
  const skip = button('Skip', 'ghost', () => answer(requestId, { kind: 'deny', message: 'I would rather not answer. Use your best judgment.' }))
  actions.append(submit, skip)
  card.append(actions)

  function refresh() {
    submit.disabled = [...picks.values()].some(({ chosen, other }) => !chosen.size && !other)
  }

  refresh()
  return card
}

function planCard(event) {
  const { requestId, input } = event
  const card = h('div', 'card')
  card.append(h('h3', '', 'Claude has a plan. Ready to start?'))

  if (typeof input.plan === 'string' && input.plan.trim()) {
    const body = markdown(input.plan)
    body.classList.add('plan-body')
    card.append(body)
  } else {
    card.append(h('p', 'sub', 'The plan is in Claude’s message above.'))
  }

  const actions = h('div', 'actions')
  actions.append(
    button('Yes, and edit automatically', 'primary', () => answer(requestId, { kind: 'plan', mode: 'acceptEdits' })),
    button('Yes, but ask before edits', 'ghost', () => answer(requestId, { kind: 'plan', mode: 'default' })),
    button('No, keep planning', 'ghost', () => {
      feedback.hidden = false
      feedback.querySelector('input').focus()
    }),
  )

  const feedback = feedbackRow('What should change in the plan?', text =>
    answer(requestId, { kind: 'deny', message: `Keep planning. ${text}` }),
  )
  card.append(actions, feedback)
  return card
}

function feedbackRow(placeholder, onSend) {
  const row = h('form', 'feedback')
  row.hidden = true
  const input = h('input')
  input.placeholder = placeholder
  const sendButton = h('button', 'ghost', 'Send')
  sendButton.type = 'submit'
  row.append(input, sendButton)
  row.addEventListener('submit', event => {
    event.preventDefault()
    if (input.value.trim()) onSend(input.value.trim())
  })
  return row
}

function button(text, className, onClick) {
  const el = h('button', className, text)
  el.type = 'button'
  el.addEventListener('click', onClick)
  return el
}

async function answer(requestId, decision) {
  const entry = view.cards.get(requestId)
  entry?.card.querySelectorAll('button, input').forEach(el => (el.disabled = true))

  try {
    await api('/api/chat/answer', { id: chat.id, requestId, decision })
  } catch (error) {
    entry?.card.querySelectorAll('button, input').forEach(el => (el.disabled = false))
    toast(error.message)
  }
}

function resolveCard({ requestId, outcome, detail }) {
  const entry = view.cards.get(requestId)
  if (!entry) return

  const { card, event } = entry
  const tool = event.toolUseId ? view.tools.get(event.toolUseId) : null
  const words = {
    allow: ['yes', '✓ Allowed'],
    always: ['yes', '✓ Always allowed'],
    deny: ['no', detail ? `✕ Declined: ${detail}` : '✕ Declined'],
    answers: ['yes', '✓ Answered'],
    plan: ['yes', detail === 'acceptEdits' ? '✓ Plan approved, editing automatically' : '✓ Plan approved, asking before edits'],
    cancelled: ['skip', 'No longer needed'],
  }
  const [tone, text] = words[outcome] ?? ['skip', outcome]

  card.classList.add('resolved')
  card.querySelector('.outcome')?.remove()
  card.append(h('div', `outcome ${tone}`, text))

  if (outcome === 'answers' && detail) {
    const list = h('div', 'reason', Object.entries(detail).map(([q, a]) => `${q} → ${a}`).join('\n'))
    list.style.whiteSpace = 'pre-wrap'
    card.append(list)
  }

  if (tool && tool.row.dataset.status === 'waiting') tool.row.dataset.status = outcome === 'deny' ? 'error' : 'running'
  view.cards.delete(requestId)
  renderStatus()
}

// The plan checklist above the composer.

function renderTodos(todos) {
  if (!Array.isArray(todos) || !todos.length || todos.every(todo => todo.status === 'completed')) {
    els.todos.hidden = true
    return
  }

  const done = todos.filter(todo => todo.status === 'completed').length
  const isCollapsed = els.todos.classList.contains('collapsed')
  const toggle = h('button', '')
  toggle.type = 'button'
  toggle.append(h('span', '', `Plan · ${done} of ${todos.length} done`), h('span', '', isCollapsed ? 'Show' : 'Hide'))
  toggle.addEventListener('click', () => {
    els.todos.classList.toggle('collapsed')
    toggle.lastChild.textContent = els.todos.classList.contains('collapsed') ? 'Show' : 'Hide'
  })

  const list = h('ul')
  for (const todo of todos) {
    const item = h('li', todo.status)
    item.append(
      h('span', 'box', todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '◐' : '○'),
      h('span', '', todo.status === 'in_progress' ? todo.activeForm || todo.content : todo.content),
    )
    list.append(item)
  }

  els.todos.replaceChildren(toggle, list)
  els.todos.hidden = false
}

// Notes

function errorBox(text) {
  return h('div', 'error-box', text)
}

function closedNote() {
  const box = h('div', 'note')
  box.append('This chat has ended. ')
  const again = button('Start a new chat', 'quiet', () => openChat({ cwd: folder }))
  again.style.color = 'var(--accent)'
  box.append(again)
  return box
}

function showBanner(text, actionText, onAction) {
  els.banner.replaceChildren(h('span', '', text))
  if (actionText) els.banner.append(button(actionText, 'ghost', onAction))
  els.banner.hidden = false
}

function hideBanner() {
  els.banner.hidden = true
}

// Controls under the message box

function setBusy(value) {
  if (value && !isBusy) busySinceMs = Date.now()
  isBusy = value
  if (!value) statusText = null
  renderStatus()
  renderSend()
}

function renderStatus() {
  if (!isBusy) {
    els.status.replaceChildren()
    return
  }

  const waiting = view.cards.size > 0
  const words = waiting ? 'Waiting for you' : statusText === 'compacting' ? 'Summarizing' : statusText || 'Working'
  const seconds = Math.floor((Date.now() - busySinceMs) / 1000)

  els.status.replaceChildren(...(waiting ? [] : [h('span', 'spinner')]), `${words}${seconds >= 3 ? ` · ${duration(seconds * 1000)}` : ''}`)
}

setInterval(() => isBusy && renderStatus(), 1000)

function renderSend() {
  const hasDraft = els.input.value.trim() || attachments.length
  const isStop = isBusy && !hasDraft

  els.send.textContent = isStop ? 'Stop' : 'Send'
  els.send.classList.toggle('stop', isStop)
  els.send.disabled = isClosed || !chat || (!isStop && !hasDraft)
}

function renderControls() {
  els.mode.value = state.mode
  els.mode.title = {
    default: 'Claude asks before changing files or running commands',
    acceptEdits: 'Claude changes files without asking, but still asks before commands',
    plan: 'Claude only reads and plans. It changes nothing until you approve the plan',
  }[state.mode] ?? ''

  const models = info?.models ?? []
  if (models.length) {
    const current = els.model.value
    els.model.replaceChildren(...models.map(model => {
      const option = h('option', '', model.displayName)
      option.value = model.value
      option.title = model.description
      return option
    }))
    els.model.value = models.some(model => model.value === state.model) ? state.model : current || models[0].value
  } else if (!els.model.options.length) {
    els.model.append(Object.assign(h('option', '', 'Default model'), { value: 'default' }))
  }
  els.model.title = state.activeModel ? `Using ${state.activeModel}` : 'Model'

  const model = models.find(candidate => candidate.value === els.model.value)
  const levels = model?.supportedEffortLevels ?? []
  els.effort.hidden = !levels.length
  if (levels.length) {
    els.effort.replaceChildren(...levels.map(level => Object.assign(h('option', '', EFFORT_WORDS[level] ?? level), { value: level })))
    els.effort.value = levels.includes(state.effort) ? state.effort : levels.includes('high') ? 'high' : levels[0]
  }

  if (info?.plan) {
    els.plan.textContent = `Claude ${info.plan.replace(/^claude\s*/i, '')}`
    els.plan.hidden = false
  }

  const isOff = isClosed || !chat
  for (const el of [els.input, els.mode, els.model, els.effort, els.attach]) el.disabled = isOff
  renderSend()
}

async function configure(change, revert) {
  try {
    await api('/api/chat/configure', { id: chat.id, ...change })
  } catch (error) {
    revert()
    toast(error.message)
  }
}

els.mode.addEventListener('change', () => configure({ mode: els.mode.value }, () => (els.mode.value = state.mode)))
els.model.addEventListener('change', () => {
  renderControls()
  configure({ model: els.model.value }, () => (els.model.value = state.model))
})
els.effort.addEventListener('change', () => configure({ effort: els.effort.value }, () => (els.effort.value = state.effort ?? '')))

// Sending

async function submit() {
  if (!chat || isClosed) return

  const text = els.input.value.trim()

  if (!text && !attachments.length) {
    if (isBusy) interrupt()
    return
  }

  const images = attachments.map(({ mediaType, data }) => ({ mediaType, data }))
  const saved = { value: els.input.value, attachments }

  els.input.value = ''
  attachments = []
  renderAttachments()
  autosize()
  closeSuggest()

  try {
    await api('/api/chat/send', { id: chat.id, text, images })
  } catch (error) {
    els.input.value = saved.value
    attachments = saved.attachments
    renderAttachments()
    autosize()
    toast(error.message)
  }
}

async function interrupt() {
  try {
    await api('/api/chat/interrupt', { id: chat.id })
  } catch (error) {
    toast(error.message)
  }
}

els.composer.addEventListener('submit', event => {
  event.preventDefault()
  submit()
})

function autosize() {
  els.input.style.height = 'auto'
  els.input.style.height = `${els.input.scrollHeight}px`
  renderSend()
}

els.input.addEventListener('input', () => {
  autosize()
  updateSuggest()
})
els.input.addEventListener('click', updateSuggest)

els.input.addEventListener('keydown', event => {
  if (suggestion && !els.suggest.hidden) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveSuggest(event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      pickSuggest(suggestion.index)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      closeSuggest()
      return
    }
  }

  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    submit()
  } else if (event.key === 'Escape' && isBusy) {
    event.preventDefault()
    interrupt()
  }
})

// Suggestions: "/" at the start lists commands, "@" lists files.

let fileTimer = null

function updateSuggest() {
  const value = els.input.value
  const caret = els.input.selectionStart
  const before = value.slice(0, caret)

  const command = /^\/(\S*)$/.exec(before)
  if (command && info?.commands?.length) {
    const needle = command[1].toLowerCase()
    const items = info.commands
      .filter(item => item.name.toLowerCase().includes(needle))
      .sort((a, b) => Number(!a.name.toLowerCase().startsWith(needle)) - Number(!b.name.toLowerCase().startsWith(needle)))
      .slice(0, 50)
      .map(item => ({ label: `/${item.name}`, desc: [item.argumentHint, item.description].filter(Boolean).join(' · '), insert: `/${item.name} `, from: 0 }))
    return showSuggest(items)
  }

  const mention = /(^|\s)@([^\s@]*)$/.exec(before)
  if (mention && chat) {
    const from = caret - mention[2].length - 1
    clearTimeout(fileTimer)
    fileTimer = setTimeout(async () => {
      try {
        const { files } = await api(`/api/chat/files?id=${encodeURIComponent(chat.id)}&q=${encodeURIComponent(mention[2])}`)
        if (els.input.selectionStart !== caret) return
        showSuggest(files.map(file => ({ label: file, desc: '', insert: `@${file} `, from })))
      } catch {
        closeSuggest()
      }
    }, 120)
    return
  }

  closeSuggest()
}

function showSuggest(items) {
  if (!items.length) return closeSuggest()

  suggestion = { items, index: 0 }
  els.suggest.replaceChildren(...items.map((item, i) => {
    const row = h('button', 'item')
    row.type = 'button'
    row.setAttribute('role', 'option')
    row.setAttribute('aria-selected', String(i === 0))
    row.append(h('code', '', item.label), h('span', 'desc', item.desc))
    row.addEventListener('mousedown', event => {
      event.preventDefault()
      pickSuggest(i)
    })
    return row
  }))
  els.suggest.hidden = false
}

function moveSuggest(step) {
  const { items } = suggestion
  suggestion.index = (suggestion.index + step + items.length) % items.length
  els.suggest.querySelectorAll('.item').forEach((row, i) => {
    row.setAttribute('aria-selected', String(i === suggestion.index))
    if (i === suggestion.index) row.scrollIntoView({ block: 'nearest' })
  })
}

function pickSuggest(index) {
  const item = suggestion?.items[index]
  if (!item) return

  const value = els.input.value
  const caret = els.input.selectionStart
  els.input.value = value.slice(0, item.from) + item.insert + value.slice(caret)
  const at = item.from + item.insert.length
  els.input.setSelectionRange(at, at)
  closeSuggest()
  autosize()
  els.input.focus()
}

function closeSuggest() {
  suggestion = null
  els.suggest.hidden = true
}

els.input.addEventListener('blur', () => setTimeout(closeSuggest, 150))

// Images: the paperclip, or paste straight into the message box.

els.attach.addEventListener('click', () => els.file.click())
els.file.addEventListener('change', () => {
  addFiles([...els.file.files])
  els.file.value = ''
})

els.input.addEventListener('paste', event => {
  const files = [...(event.clipboardData?.files ?? [])].filter(file => file.type.startsWith('image/'))
  if (files.length) {
    event.preventDefault()
    addFiles(files)
  }
})

function addFiles(files) {
  for (const file of files) {
    if (attachments.length >= MAX_IMAGES) {
      toast(`You can attach up to ${MAX_IMAGES} images.`)
      break
    }
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type)) {
      toast(`${file.name} is not a PNG, JPEG, GIF or WebP image.`)
      continue
    }
    if (file.size > MAX_IMAGE_BYTES) {
      toast(`${file.name} is larger than 5 MB.`)
      continue
    }

    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      attachments.push({ mediaType: file.type, data: url.slice(url.indexOf(',') + 1), url })
      renderAttachments()
    }
    reader.readAsDataURL(file)
  }
}

function renderAttachments() {
  els.attachments.replaceChildren(...attachments.map((attachment, i) => {
    const thumb = h('div', 'thumb')
    const img = h('img')
    img.src = attachment.url
    img.alt = 'Attached image'
    const remove = button('×', '', () => {
      attachments.splice(i, 1)
      renderAttachments()
    })
    remove.setAttribute('aria-label', 'Remove image')
    thumb.append(img, remove)
    return thumb
  }))
  els.attachments.hidden = !attachments.length
  renderSend()
}

// Sidebar: folder and recent chats

let sessions = []
let sessionsTimer = null

async function loadSessions() {
  try {
    const data = await api(`/api/chat/sessions?cwd=${encodeURIComponent(folder)}`)
    sessions = data.sessions
  } catch {
    sessions = []
  }
  renderSessions()
}

function scheduleSessionsRefresh() {
  clearTimeout(sessionsTimer)
  sessionsTimer = setTimeout(loadSessions, 800)
}

function renderSessions() {
  if (!sessions.length) {
    els.sessions.replaceChildren(h('li', 'side-empty', 'No chats in this folder yet.'))
    return
  }

  els.sessions.replaceChildren(...sessions.map(session => {
    const item = h('li')
    const link = h('button', 'session')
    link.type = 'button'
    link.setAttribute('aria-current', String(session.id === chat?.id))
    const title = h('span', 'title')
    if (session.isOpen) title.append(h('span', 'live'))
    title.append(session.title)
    title.title = session.title
    link.append(title, h('span', 'when', ago(session.lastModified)))
    link.addEventListener('click', () => {
      if (session.id !== chat?.id) location.hash = session.id
      closeSidebar()
    })
    item.append(link)
    return item
  }))
}

els.newChat.addEventListener('click', () => openChat({ cwd: folder }))

els.folderForm.addEventListener('submit', async event => {
  event.preventDefault()
  const value = els.folder.value.trim()
  if (!value) return

  els.folderError.hidden = true
  try {
    await api('/api/chat/open', { cwd: value }).then(({ id, cwd }) => {
      setFolder(cwd)
      return id
    })
    await openChat({ cwd: folder })
    loadSessions()
  } catch (error) {
    els.folderError.textContent = error.message
    els.folderError.hidden = false
  }
})

window.addEventListener('hashchange', () => {
  const id = location.hash.slice(1)
  if (id && id !== chat?.id) openChat({ sessionId: id })
})

function closeSidebar() {
  els.sidebar.classList.remove('open')
  els.scrim.hidden = true
  els.toggleSidebar.setAttribute('aria-expanded', 'false')
}

els.toggleSidebar.addEventListener('click', () => {
  const isOpen = els.sidebar.classList.toggle('open')
  els.scrim.hidden = !isOpen
  els.toggleSidebar.setAttribute('aria-expanded', String(isOpen))
})
els.scrim.addEventListener('click', closeSidebar)

// Start

async function start() {
  try {
    const config = await api('/api/chat/config')
    setFolder(remember('folder') || config.defaultFolder)
  } catch (error) {
    els.messages.replaceChildren(errorBox(`Couldn't reach fin-code: ${error.message}`))
    return
  }

  const sessionId = location.hash.slice(1)
  await openChat(sessionId ? { sessionId } : { cwd: folder })
  loadSessions()
  els.input.focus()
}

start()
