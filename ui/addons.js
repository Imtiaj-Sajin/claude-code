// The add-ons page's side of the server: reads this repository's plugins,
// and installs, removes and switches them with fixed `claude plugin` commands.

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { GROUPS, PLUGINS } from './friendly.js'

export const ROOT = path.resolve(import.meta.dirname, '..')

const CATALOG_FILE = path.join(ROOT, '.claude-plugin', 'marketplace.json')
const CLAUDE_TIMEOUT_MS = 180_000
const TOOL_TIMEOUT_MS = 10_000

// Runs `command args…` without a shell and gathers what it prints.
export function run(command, args, { cwd = ROOT, timeoutMs = CLAUDE_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    let stdout = ''
    let stderr = ''
    let child

    try {
      child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      resolve({ ok: false, stdout, stderr: error.message, missing: true })
      return
    }

    const timer = setTimeout(() => child.kill(), timeoutMs)

    child.stdout.on('data', chunk => (stdout += chunk))
    child.stderr.on('data', chunk => (stderr += chunk))
    child.on('error', error => {
      clearTimeout(timer)
      resolve({ ok: false, stdout, stderr: error.message, missing: error.code === 'ENOENT' })
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim(), missing: false })
    })
  })
}

function runClaude(args) {
  return run('claude', args)
}

// One `claude plugin` call at a time, so two clicks never write settings at once.
let queue = Promise.resolve()

function serially(task) {
  const result = queue.then(task, task)
  queue = result.catch(() => {})
  return result
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function frontmatterOf(file) {
  let text

  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return {}
  }

  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const fields = {}

  for (const line of block ? block[1].split(/\r?\n/) : []) {
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)

    if (field) {
      fields[field[1]] = field[2].replace(/^(["'])(.*)\1$/, '$2')
    }
  }

  return fields
}

function entriesOf(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function commandsOf(dir) {
  return entriesOf(path.join(dir, 'commands'))
    .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
    .map(entry => {
      const fields = frontmatterOf(path.join(dir, 'commands', entry.name))

      return {
        name: entry.name.slice(0, -'.md'.length),
        description: fields.description ?? '',
        argumentHint: fields['argument-hint'] ?? '',
      }
    })
}

function agentsOf(dir) {
  return entriesOf(path.join(dir, 'agents'))
    .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
    .map(entry => {
      const fields = frontmatterOf(path.join(dir, 'agents', entry.name))

      return {
        name: fields.name || entry.name.slice(0, -'.md'.length),
        description: fields.description ?? '',
      }
    })
}

function skillsOf(dir) {
  return entriesOf(path.join(dir, 'skills'))
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const fields = frontmatterOf(path.join(dir, 'skills', entry.name, 'SKILL.md'))

      return { name: fields.name || entry.name, description: fields.description ?? '' }
    })
}

function hookEventsOf(dir) {
  const hooks = readJson(path.join(dir, 'hooks', 'hooks.json'))?.hooks

  return hooks && typeof hooks === 'object' ? Object.keys(hooks) : []
}

function describePlugin(entry) {
  const dir = typeof entry.source === 'string' ? path.resolve(ROOT, entry.source) : null
  const manifest = (dir && readJson(path.join(dir, '.claude-plugin', 'plugin.json'))) ?? {}
  const friendly = PLUGINS[entry.name] ?? {}

  return {
    name: entry.name,
    title: friendly.title ?? entry.name,
    summary: friendly.summary ?? manifest.description ?? entry.description ?? '',
    description: manifest.description ?? entry.description ?? '',
    group: friendly.group ?? 'advanced',
    cost: friendly.cost ?? 'normal',
    tryIt: friendly.tryIt ?? null,
    notes: friendly.notes ?? [],
    needs: friendly.needs ?? [],
    version: manifest.version ?? entry.version ?? null,
    author: manifest.author?.name ?? entry.author?.name ?? null,
    commands: dir ? commandsOf(dir) : [],
    agents: dir ? agentsOf(dir) : [],
    skills: dir ? skillsOf(dir) : [],
    hookEvents: dir ? hookEventsOf(dir) : [],
  }
}

function readCatalog() {
  const market = readJson(CATALOG_FILE)

  if (!market || !Array.isArray(market.plugins)) {
    throw new Error(`Could not read ${path.relative(ROOT, CATALOG_FILE)}`)
  }

  return { name: market.name, plugins: market.plugins.map(describePlugin) }
}

// Whether each tool a plugin calls runs here. The Microsoft Store's `python3`
// stub exists on PATH but prints an install hint instead of a version.
const toolChecks = new Map()

function hasTool(tool) {
  if (!toolChecks.has(tool)) {
    toolChecks.set(
      tool,
      run(tool, ['--version'], { timeoutMs: TOOL_TIMEOUT_MS }).then(
        result => result.ok && /\d+\.\d+/.test(result.stdout + result.stderr),
      ),
    )
  }

  return toolChecks.get(tool)
}

function idOf(row) {
  if (row.pluginId || row.id) {
    return row.pluginId ?? row.id
  }

  const marketplace = row.marketplace ?? row.marketplaceName

  return marketplace ? `${row.name}@${marketplace}` : row.name
}

async function installedPlugins() {
  const result = await runClaude(['plugin', 'list', '--json'])

  if (!result.ok) {
    return { error: explain(result), rows: [] }
  }

  const data = parseJson(result.stdout)
  const rows = Array.isArray(data) ? data : (data?.installed ?? [])

  return {
    error: null,
    rows: rows.map(row => ({ id: idOf(row), isEnabled: row.enabled !== false })),
  }
}

async function marketplaces() {
  const result = await runClaude(['plugin', 'marketplace', 'list', '--json'])
  const data = result.ok ? parseJson(result.stdout) : null

  return Array.isArray(data) ? data : []
}

async function readState() {
  const catalog = readCatalog()

  const [markets, installed] = await Promise.all([marketplaces(), installedPlugins()])
  const market = markets.find(candidate => candidate.name === catalog.name) ?? null

  const tools = [...new Set(catalog.plugins.flatMap(plugin => plugin.needs.map(need => need.tool)))]
  const found = await Promise.all(tools.map(hasTool))
  const isToolFound = Object.fromEntries(tools.map((tool, i) => [tool, found[i]]))

  return {
    folder: ROOT,
    marketplace: catalog.name,
    isConnected: market !== null,
    connectedTo: market?.path ?? market?.installLocation ?? market?.repo ?? null,
    error: installed.error,
    groups: GROUPS,
    plugins: catalog.plugins.map(plugin => {
      const row = installed.rows.find(candidate => candidate.id === `${plugin.name}@${catalog.name}`)

      return {
        ...plugin,
        isInstalled: row !== undefined,
        isEnabled: row?.isEnabled ?? false,
        needs: plugin.needs.map(need => ({ ...need, isFound: isToolFound[need.tool] })),
      }
    }),
  }
}

// What went wrong, in words, from a failed `claude` run.
function explain(result) {
  if (result.missing) {
    return 'Claude Code was not found on this computer. Install it from https://claude.com/claude-code, then reopen this page.'
  }

  return result.stderr || result.stdout || 'The command failed without saying why.'
}

const ACTIONS = {
  connect: () => ['plugin', 'marketplace', 'add', ROOT],
  install: (marketplace, name) => ['plugin', 'install', `${name}@${marketplace}`],
  uninstall: (marketplace, name) => ['plugin', 'uninstall', `${name}@${marketplace}`],
  enable: (marketplace, name) => ['plugin', 'enable', `${name}@${marketplace}`],
  disable: (marketplace, name) => ['plugin', 'disable', `${name}@${marketplace}`],
}

const NEEDS_PLUGIN = new Set(['install', 'uninstall', 'enable', 'disable'])

async function perform(action, name) {
  const catalog = readCatalog()

  if (!Object.hasOwn(ACTIONS, action)) {
    return { status: 400, body: { error: `Unknown action: ${action}` } }
  }

  if (NEEDS_PLUGIN.has(action) && !catalog.plugins.some(plugin => plugin.name === name)) {
    return { status: 400, body: { error: `No add-on named ${name} in this folder.` } }
  }

  const result = await runClaude(ACTIONS[action](catalog.name, name))
  const state = await readState()

  return {
    status: 200,
    body: {
      ok: result.ok,
      message: result.ok ? result.stdout || result.stderr : explain(result),
      state,
    },
  }
}

export function readAddons() {
  return serially(readState)
}

export function performAddonAction(action, name) {
  return serially(() => perform(action, name))
}
