// The chat page's side of the server: one Claude Code session per chat,
// driven through the Agent SDK, with every event fanned out to the browser
// tabs watching it and every permission prompt waiting on a person's click.

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import {
  getSessionInfo,
  getSessionMessages,
  listSessions,
  query,
} from '@anthropic-ai/claude-agent-sdk'

import { run } from './addons.js'

const MODES = ['default', 'acceptEdits', 'plan']
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const MAX_IMAGES = 5
const MAX_EVENTS = 20_000
const IDLE_CLOSE_MS = 15 * 60_000
const HEARTBEAT_MS = 25_000
const FILE_LIST_TTL_MS = 60_000
const MAX_FILES = 20_000
const SKIPPED_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next'])

// Messages the page never draws: streaming noise it has no use for.
const IGNORED_TYPES = new Set(['rate_limit_event'])
const IGNORED_SUBTYPES = new Set(['notification', 'hook_started', 'hook_progress', 'hook_response'])

// A queue the SDK reads user messages from, one turn at a time.
class Inbox {
  #items = []
  #waiting = null
  #isClosed = false

  push(item) {
    if (this.#waiting) {
      const resolve = this.#waiting
      this.#waiting = null
      resolve({ value: item, done: false })
    } else {
      this.#items.push(item)
    }
  }

  close() {
    this.#isClosed = true
    this.#waiting?.({ value: undefined, done: true })
    this.#waiting = null
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.#items.length) {
          return Promise.resolve({ value: this.#items.shift(), done: false })
        }

        if (this.#isClosed) {
          return Promise.resolve({ value: undefined, done: true })
        }

        return new Promise(resolve => (this.#waiting = resolve))
      },
      return: () => {
        this.close()
        return Promise.resolve({ value: undefined, done: true })
      },
    }
  }
}

// Words for the rules an "always allow" writes, and where it writes them.
const DESTINATIONS = {
  session: 'for this chat',
  localSettings: 'in this project, just for you',
  projectSettings: 'in this project',
  userSettings: 'in every project',
}

function describeSuggestions(suggestions = []) {
  return suggestions.flatMap(update => {
    const where = DESTINATIONS[update.destination] ?? ''

    if (update.type === 'addRules' && update.behavior === 'allow') {
      return update.rules.map(rule => ({
        rule: rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName,
        where,
      }))
    }

    if (update.type === 'addDirectories') {
      return update.directories.map(dir => ({ rule: `Access to ${dir}`, where }))
    }

    if (update.type === 'setMode') {
      const words = {
        acceptEdits: 'Edit files without asking',
        bypassPermissions: 'Stop asking about anything',
        plan: 'Only plan, change nothing',
      }

      return [{ rule: words[update.mode] ?? `Switch to ${update.mode}`, where }]
    }

    return []
  })
}

class Chat {
  constructor({ id, cwd, isResumed, history }) {
    this.id = id
    this.cwd = cwd
    this.events = []
    this.clients = new Set()
    this.pending = new Map()
    this.inbox = new Inbox()
    this.isBusy = false
    this.isClosed = false
    this.lastActiveMs = Date.now()
    this.stderrTail = ''
    this.info = null
    this.state = { mode: 'default', model: 'default', effort: null, activeModel: null }

    for (const message of history) {
      this.record(message)
    }

    this.query = query({
      prompt: this.inbox,
      options: {
        cwd,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        includePartialMessages: true,
        ...(isResumed ? { resume: id } : { sessionId: id }),
        canUseTool: (toolName, input, options) => this.askPermission(toolName, input, options),
        stderr: text => (this.stderrTail = (this.stderrTail + text).slice(-4000)),
      },
    })

    this.pump()
    this.loadInfo()
  }

  // What a tab needs before the replayed events: who this chat is and how it is set.
  hello() {
    return {
      kind: 'hello',
      id: this.id,
      cwd: this.cwd,
      isBusy: this.isBusy,
      isClosed: this.isClosed,
      state: this.state,
      info: this.info,
    }
  }

  attach(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
    })

    write(res, this.hello())

    for (const event of this.events) {
      write(res, event)
    }

    this.clients.add(res)
    this.touch()

    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS)

    res.on('close', () => {
      clearInterval(heartbeat)
      this.clients.delete(res)
      this.touch()
    })
  }

  touch() {
    this.lastActiveMs = Date.now()
  }

  // Sends to every tab; `record` also keeps it for tabs that attach later.
  broadcast(event) {
    for (const res of this.clients) {
      write(res, event)
    }
  }

  record(event) {
    this.events.push(event)

    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS)
    }

    this.broadcast(event)
  }

  setBusy(isBusy) {
    if (this.isBusy !== isBusy) {
      this.isBusy = isBusy
      this.broadcast({ kind: 'busy', isBusy })
    }
  }

  setState(changes) {
    Object.assign(this.state, changes)
    this.broadcast({ kind: 'state', state: this.state })
  }

  async loadInfo() {
    try {
      const init = await this.query.initializationResult()

      this.info = {
        commands: (init.commands ?? []).map(({ name, description, argumentHint }) => ({
          name,
          description,
          argumentHint,
        })),
        models: (init.models ?? []).map(model => ({
          value: model.value,
          displayName: model.displayName,
          description: model.description,
          supportedEffortLevels: model.supportsEffort ? (model.supportedEffortLevels ?? []) : [],
        })),
        plan: init.account?.subscriptionType ?? null,
      }

      if (init.current_permission_mode && MODES.includes(init.current_permission_mode)) {
        this.state.mode = init.current_permission_mode
      }

      this.broadcast({ kind: 'info', info: this.info, state: this.state })
    } catch (error) {
      this.record({ kind: 'error', message: `Claude Code could not start: ${error.message}` })
    }
  }

  async pump() {
    try {
      for await (const message of this.query) {
        this.onMessage(message)
      }
    } catch (error) {
      const detail = this.stderrTail.trim()

      this.record({
        kind: 'error',
        message: `${error.message}${detail ? `\n\n${detail.split('\n').slice(-8).join('\n')}` : ''}`,
      })
    } finally {
      this.isClosed = true
      this.setBusy(false)
      this.cancelPending('The chat ended.')
      this.broadcast({ kind: 'closed' })
    }
  }

  onMessage(message) {
    this.touch()

    if (IGNORED_TYPES.has(message.type) || IGNORED_SUBTYPES.has(message.subtype)) {
      return
    }

    if (message.type === 'stream_event') {
      if (message.event.type === 'message_start') {
        this.setBusy(true)
      }

      // Live only: the finished message replaces the stream, so tabs that
      // attach later need nothing but the finished one.
      if (message.parent_tool_use_id === null) {
        this.broadcast({ kind: 'stream', event: message.event })
      }

      return
    }

    if (message.type === 'system' && message.subtype === 'init') {
      this.setState({
        activeModel: message.model,
        effort: message.effort ?? this.state.effort,
        ...(MODES.includes(message.permissionMode) ? { mode: message.permissionMode } : {}),
      })

      return
    }

    if (message.type === 'system' && message.subtype === 'status') {
      if (MODES.includes(message.permissionMode)) {
        this.setState({ mode: message.permissionMode })
      }

      this.broadcast({ kind: 'status', status: message.status ?? null })

      return
    }

    if (message.type === 'system' && message.subtype === 'api_retry') {
      this.broadcast({ kind: 'status', status: `Retrying (attempt ${message.attempt} of ${message.max_retries})` })

      return
    }

    if (message.type === 'assistant') {
      this.setBusy(true)
    }

    this.record({ kind: 'sdk', message })

    if (message.type === 'result') {
      this.setBusy(false)
    }
  }

  send({ text, images }) {
    if (this.isClosed) {
      throw new Error('This chat has ended. Start a new one or reopen it from the list.')
    }

    const content = [
      ...images.map(image => ({
        type: 'image',
        source: { type: 'base64', media_type: image.mediaType, data: image.data },
      })),
      ...(text ? [{ type: 'text', text }] : []),
    ]

    this.record({ kind: 'user', text, images })
    this.inbox.push({
      type: 'user',
      message: { role: 'user', content: images.length ? content : text },
      parent_tool_use_id: null,
      origin: { kind: 'human' },
    })
    this.setBusy(true)
  }

  askPermission(toolName, input, options) {
    const requestId = randomUUID()

    return new Promise(resolve => {
      const canAlwaysAllow = Boolean(options.suggestions?.length) && !options.suppressAlwaysAllowRule

      this.pending.set(requestId, {
        resolve,
        toolName,
        input,
        suggestions: canAlwaysAllow ? options.suggestions : undefined,
      })

      this.record({
        kind: 'permission',
        requestId,
        toolName,
        input,
        toolUseId: options.toolUseID,
        agentId: options.agentID ?? null,
        title: options.title ?? null,
        displayName: options.displayName ?? null,
        description: options.description ?? null,
        decisionReason: options.decisionReason ?? null,
        blockedPath: options.blockedPath ?? null,
        isDefaultNo: options.defaultToNo === true,
        alwaysAllow: canAlwaysAllow ? describeSuggestions(options.suggestions) : [],
      })

      options.signal.addEventListener(
        'abort',
        () => {
          if (this.pending.delete(requestId)) {
            this.record({ kind: 'resolved', requestId, outcome: 'cancelled' })
            resolve({ behavior: 'deny', message: 'The request was cancelled.' })
          }
        },
        { once: true },
      )
    })
  }

  // A person's click on a permission, question or plan card.
  answer(requestId, decision) {
    const request = this.pending.get(requestId)

    if (!request) {
      throw new Error('That request is no longer waiting for an answer.')
    }

    const result = resultOf(request, decision)

    this.pending.delete(requestId)
    this.record({ kind: 'resolved', requestId, outcome: decision.kind, detail: detailOf(decision) })
    request.resolve(result)

    if (decision.kind === 'plan') {
      this.setState({ mode: decision.mode })
    }
  }

  cancelPending(message) {
    for (const [requestId, request] of this.pending) {
      this.record({ kind: 'resolved', requestId, outcome: 'cancelled' })
      request.resolve({ behavior: 'deny', message })
    }

    this.pending.clear()
  }

  async interrupt() {
    await this.query.interrupt()
  }

  async configure({ mode, model, effort }) {
    if (mode !== undefined) {
      if (!MODES.includes(mode)) {
        throw new Error(`Unknown mode: ${mode}`)
      }

      await this.query.setPermissionMode(mode)
      this.setState({ mode })
    }

    if (model !== undefined) {
      if (this.info && !this.info.models.some(candidate => candidate.value === model)) {
        throw new Error(`Unknown model: ${model}`)
      }

      await this.query.setModel(model === 'default' ? undefined : model)
      this.setState({ model })
    }

    if (effort !== undefined) {
      if (!EFFORTS.includes(effort)) {
        throw new Error(`Unknown effort: ${effort}`)
      }

      await this.query.applyFlagSettings({ effortLevel: effort })
      this.setState({ effort })
    }
  }

  close() {
    this.cancelPending('The chat was closed.')
    this.inbox.close()
    this.query.close()
  }
}

function resultOf(request, decision) {
  switch (decision.kind) {
    case 'allow':
      return { behavior: 'allow', updatedInput: request.input }

    case 'always':
      if (!request.suggestions) {
        throw new Error('"Always allow" is not offered for this request.')
      }

      return { behavior: 'allow', updatedInput: request.input, updatedPermissions: request.suggestions }

    case 'deny':
      return {
        behavior: 'deny',
        message: decision.message
          ? `The user declined this and said: ${decision.message}`
          : 'The user declined this action.',
      }

    case 'answers': {
      if (request.toolName !== 'AskUserQuestion' || typeof decision.answers !== 'object') {
        throw new Error('Answers only go to a question.')
      }

      const answers = Object.fromEntries(
        Object.entries(decision.answers).map(([question, answer]) => [String(question), String(answer)]),
      )

      return { behavior: 'allow', updatedInput: { ...request.input, answers } }
    }

    case 'plan':
      if (request.toolName !== 'ExitPlanMode' || !['default', 'acceptEdits'].includes(decision.mode)) {
        throw new Error('Plan approval only goes to a finished plan.')
      }

      return {
        behavior: 'allow',
        updatedInput: request.input,
        updatedPermissions: [{ type: 'setMode', mode: decision.mode, destination: 'session' }],
      }

    default:
      throw new Error(`Unknown answer: ${decision.kind}`)
  }
}

function detailOf(decision) {
  if (decision.kind === 'deny') return decision.message || null
  if (decision.kind === 'answers') return decision.answers
  if (decision.kind === 'plan') return decision.mode
  return null
}

function write(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`)
}

// A saved session's messages, as the events a live chat would have recorded.
function historyEventsOf(messages) {
  const events = []

  for (const entry of messages) {
    const message = entry.message

    if (entry.type === 'assistant') {
      events.push({
        kind: 'sdk',
        message: { type: 'assistant', message, parent_tool_use_id: entry.parent_tool_use_id },
      })
    } else if (entry.type === 'user') {
      const blocks = typeof message?.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : Array.isArray(message?.content) ? message.content : []

      const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('\n')
      const results = blocks.filter(block => block.type === 'tool_result')

      if (results.length) {
        events.push({
          kind: 'sdk',
          message: { type: 'user', message: { role: 'user', content: results }, parent_tool_use_id: entry.parent_tool_use_id },
        })
      } else if (text && entry.parent_tool_use_id === null) {
        const images = blocks
          .filter(block => block.type === 'image' && block.source?.type === 'base64')
          .map(block => ({ mediaType: block.source.media_type, data: block.source.data }))

        events.push({ kind: 'user', text, images, isHistory: true })
      }
    }
  }

  return events
}

function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

export class ChatHub {
  #chats = new Map()
  #fileLists = new Map()

  constructor() {
    setInterval(() => this.#closeIdle(), 60_000).unref()
  }

  get(id) {
    const chat = this.#chats.get(id)

    if (!chat) {
      throw Object.assign(new Error('That chat is not open. Reload the page.'), { status: 404 })
    }

    return chat
  }

  async open({ cwd, sessionId }) {
    if (sessionId && this.#chats.has(sessionId)) {
      return this.#chats.get(sessionId)
    }

    let folder = typeof cwd === 'string' ? path.resolve(cwd.trim()) : ''
    let history = []

    if (sessionId) {
      if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
        throw Object.assign(new Error('That chat id is not valid.'), { status: 400 })
      }

      const saved = await getSessionInfo(sessionId)

      if (!saved) {
        throw Object.assign(new Error('That chat was not found. It may have been deleted.'), { status: 404 })
      }

      folder = saved.cwd ?? folder
      history = historyEventsOf(await getSessionMessages(sessionId, { dir: folder }))
    }

    if (!isDirectory(folder)) {
      throw Object.assign(new Error(`This folder does not exist: ${folder}`), { status: 400 })
    }

    const id = sessionId ?? randomUUID()
    const chat = new Chat({ id, cwd: folder, isResumed: Boolean(sessionId), history })

    this.#chats.set(id, chat)

    return chat
  }

  async sessions(cwd) {
    const folder = path.resolve(String(cwd ?? '').trim())

    if (!isDirectory(folder)) {
      return []
    }

    const sessions = await listSessions({ dir: folder, limit: 50 })

    return sessions
      .filter(session => session.summary || session.firstPrompt)
      .map(session => ({
        id: session.sessionId,
        title: session.customTitle || session.summary || session.firstPrompt,
        lastModified: session.lastModified,
        branch: session.gitBranch ?? null,
        isOpen: this.#chats.has(session.sessionId),
      }))
  }

  // Files under a chat's folder whose path contains `text`, for @-mentions.
  async files(id, text) {
    const chat = this.get(id)
    const needle = String(text ?? '').toLowerCase().replaceAll('\\', '/')
    const all = await this.#fileListOf(chat.cwd)

    const scored = []

    for (const file of all) {
      const lower = file.toLowerCase()
      const base = lower.slice(lower.lastIndexOf('/') + 1)
      const score = !needle ? 3 : base.startsWith(needle) ? 0 : base.includes(needle) ? 1 : lower.includes(needle) ? 2 : -1

      if (score >= 0) {
        scored.push([score, file.length, file])
      }
    }

    return scored
      .sort((a, b) => a[0] - b[0] || a[1] - b[1])
      .slice(0, 30)
      .map(([, , file]) => file)
  }

  async #fileListOf(cwd) {
    const cached = this.#fileLists.get(cwd)

    if (cached && Date.now() - cached.atMs < FILE_LIST_TTL_MS) {
      return cached.files
    }

    const git = await run('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd,
      timeoutMs: 15_000,
    })

    const files = (git.ok ? git.stdout.split('\n') : walk(cwd))
      .filter(file => file && !/(^|\/)(node_modules|\.git)\//.test(file))
      .slice(0, MAX_FILES)

    this.#fileLists.set(cwd, { atMs: Date.now(), files })

    return files
  }

  #closeIdle() {
    const now = Date.now()

    for (const [id, chat] of this.#chats) {
      const isIdle = chat.clients.size === 0 && !chat.isBusy && chat.pending.size === 0

      if (chat.isClosed || (isIdle && now - chat.lastActiveMs > IDLE_CLOSE_MS)) {
        chat.close()
        this.#chats.delete(id)
      }
    }
  }

  closeAll() {
    for (const chat of this.#chats.values()) {
      chat.close()
    }

    this.#chats.clear()
  }
}

// Every file under `root`, skipping dependency and build folders.
function walk(root) {
  const files = []
  const stack = ['']

  while (stack.length && files.length < MAX_FILES) {
    const rel = stack.pop()
    let entries

    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name

      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) stack.push(child)
      } else if (entry.isFile()) {
        files.push(child)
      }
    }
  }

  return files
}

export function parseImages(images) {
  if (images === undefined) return []

  if (!Array.isArray(images) || images.length > MAX_IMAGES) {
    throw Object.assign(new Error(`Attach up to ${MAX_IMAGES} images.`), { status: 400 })
  }

  return images.map(image => {
    if (!IMAGE_TYPES.includes(image?.mediaType) || typeof image.data !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(image.data)) {
      throw Object.assign(new Error('Images must be PNG, JPEG, GIF or WebP.'), { status: 400 })
    }

    return { mediaType: image.mediaType, data: image.data }
  })
}
