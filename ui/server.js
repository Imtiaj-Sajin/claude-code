#!/usr/bin/env node
// fin-code's local web app: a chat with Claude Code at /, and a page for
// installing this repository's add-ons at /addons.
//
//   node ui/server.js           start it
//   node ui/server.js --open    start it and open the page (ui/start.bat)
//
// It listens on 127.0.0.1 only, and answers only pages it served itself: a
// request from any other site or host name is refused.

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { performAddonAction, readAddons, ROOT } from './addons.js'
import { ChatHub, parseImages } from './chat.js'

const HOST = '127.0.0.1'
const FIRST_PORT = Number(process.env.ADDON_UI_PORT) || 4477
const PORT_ATTEMPTS = 10
const APP_ID = 'fin-code-addon-manager'
const SMALL_BODY_BYTES = 100_000
const CHAT_BODY_BYTES = 30_000_000

const PUBLIC = path.join(import.meta.dirname, 'public')
const MODULES = path.join(import.meta.dirname, 'node_modules')

// Every file the server hands out, by the path the pages ask for.
const FILES = {
  '/': [path.join(PUBLIC, 'chat.html'), 'text/html; charset=utf-8'],
  '/addons': [path.join(PUBLIC, 'addons.html'), 'text/html; charset=utf-8'],
  '/theme.css': [path.join(PUBLIC, 'theme.css'), 'text/css; charset=utf-8'],
  '/chat.css': [path.join(PUBLIC, 'chat.css'), 'text/css; charset=utf-8'],
  '/chat.js': [path.join(PUBLIC, 'chat.js'), 'text/javascript; charset=utf-8'],
  '/vendor/marked.js': [path.join(MODULES, 'marked', 'lib', 'marked.esm.js'), 'text/javascript; charset=utf-8'],
  '/vendor/purify.js': [path.join(MODULES, 'dompurify', 'dist', 'purify.es.mjs'), 'text/javascript; charset=utf-8'],
}

const hub = new ChatHub()

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function send(res, status, type, body) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  })
  res.end(body)
}

function sendJson(res, status, value) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(value))
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0

    req.on('data', chunk => {
      size += chunk.length

      if (size > limit) {
        reject(new HttpError(413, 'That is too large to send.'))
        req.destroy()
        return
      }

      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function readJsonBody(req, limit = SMALL_BODY_BYTES) {
  try {
    return JSON.parse(await readBody(req, limit)) ?? {}
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(400, 'The request was not valid JSON.')
  }
}

// Only this app's own pages may call it: the Host must be this server (no
// DNS rebinding), a browser must not flag the call as cross-site, an Origin
// must be ours, and a POST must carry our header, which another site cannot
// send without a preflight this server never answers.
function isOwnRequest(req, port) {
  const own = [`${HOST}:${port}`, `localhost:${port}`]
  const origin = req.headers.origin

  return (
    own.includes(req.headers.host) &&
    req.headers['sec-fetch-site'] !== 'cross-site' &&
    (origin === undefined || own.some(host => origin === `http://${host}`)) &&
    (req.method !== 'POST' || req.headers['x-addon-manager'] === '1')
  )
}

async function route(req, res, port) {
  const url = new URL(req.url, `http://${HOST}:${port}`)
  const { pathname, searchParams } = url

  if (req.method === 'GET' && Object.hasOwn(FILES, pathname)) {
    const [file, type] = FILES[pathname]

    return send(res, 200, type, fs.readFileSync(file))
  }

  if (req.method === 'GET' && pathname === '/api/ping') {
    return sendJson(res, 200, { app: APP_ID, folder: ROOT })
  }

  // Add-ons
  if (req.method === 'GET' && pathname === '/api/addons/state') {
    return sendJson(res, 200, await readAddons())
  }

  if (req.method === 'POST' && pathname === '/api/addons/action') {
    const { action, name } = await readJsonBody(req)
    const { status, body } = await performAddonAction(action, name)

    return sendJson(res, status, body)
  }

  // Chat
  if (req.method === 'GET' && pathname === '/api/chat/config') {
    return sendJson(res, 200, { defaultFolder: ROOT })
  }

  if (req.method === 'GET' && pathname === '/api/chat/sessions') {
    return sendJson(res, 200, { sessions: await hub.sessions(searchParams.get('cwd')) })
  }

  if (req.method === 'GET' && pathname === '/api/chat/events') {
    return hub.get(searchParams.get('id')).attach(res)
  }

  if (req.method === 'GET' && pathname === '/api/chat/files') {
    return sendJson(res, 200, { files: await hub.files(searchParams.get('id'), searchParams.get('q')) })
  }

  if (req.method === 'POST' && pathname === '/api/chat/open') {
    const { cwd, sessionId } = await readJsonBody(req)
    const chat = await hub.open({ cwd, sessionId: sessionId || undefined })

    return sendJson(res, 200, { id: chat.id, cwd: chat.cwd })
  }

  if (req.method === 'POST' && pathname === '/api/chat/send') {
    const { id, text, images } = await readJsonBody(req, CHAT_BODY_BYTES)
    const message = typeof text === 'string' ? text.trim() : ''
    const attached = parseImages(images)

    if (!message && !attached.length) {
      throw new HttpError(400, 'Type a message first.')
    }

    hub.get(id).send({ text: message, images: attached })

    return sendJson(res, 200, { ok: true })
  }

  if (req.method === 'POST' && pathname === '/api/chat/answer') {
    const { id, requestId, decision } = await readJsonBody(req)

    if (!decision || typeof decision.kind !== 'string') {
      throw new HttpError(400, 'Missing the answer.')
    }

    hub.get(id).answer(requestId, decision)

    return sendJson(res, 200, { ok: true })
  }

  if (req.method === 'POST' && pathname === '/api/chat/interrupt') {
    const { id } = await readJsonBody(req)

    await hub.get(id).interrupt()

    return sendJson(res, 200, { ok: true })
  }

  if (req.method === 'POST' && pathname === '/api/chat/configure') {
    const { id, mode, model, effort } = await readJsonBody(req)

    await hub.get(id).configure({ mode, model, effort })

    return sendJson(res, 200, { ok: true })
  }

  throw new HttpError(404, 'Not found')
}

function createServer(port) {
  return http.createServer(async (req, res) => {
    if (!isOwnRequest(req, port)) {
      return send(res, 403, 'text/plain; charset=utf-8', 'Forbidden')
    }

    try {
      await route(req, res, port)
    } catch (error) {
      if (res.headersSent) {
        res.end()
      } else {
        sendJson(res, error.status ?? 500, { error: error.message })
      }
    }
  })
}

function openInBrowser(url) {
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]]

  spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
}

// Whether this folder's app already answers on `port`.
function isAlreadyRunning(port) {
  return new Promise(resolve => {
    const req = http.get({ host: HOST, port, path: '/api/ping', timeout: 1000 }, res => {
      let body = ''

      res.on('data', chunk => (body += chunk))
      res.on('end', () => {
        try {
          const ping = JSON.parse(body)

          resolve(ping.app === APP_ID && ping.folder === ROOT)
        } catch {
          resolve(false)
        }
      })
    })

    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(false))
  })
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = createServer(port)

    server.once('error', reject)
    server.listen(port, HOST, () => resolve(server))
  })
}

async function main() {
  const shouldOpen = process.argv.includes('--open')

  if (await isAlreadyRunning(FIRST_PORT)) {
    const url = `http://${HOST}:${FIRST_PORT}/`

    console.log(`fin-code is already running at ${url}`)

    if (shouldOpen) {
      openInBrowser(url)
    }

    return
  }

  for (let port = FIRST_PORT; port < FIRST_PORT + PORT_ATTEMPTS; port++) {
    try {
      await listen(port)
    } catch (error) {
      if (error.code === 'EADDRINUSE') {
        continue
      }

      throw error
    }

    const url = `http://${HOST}:${port}/`

    console.log(`fin-code is running at ${url}`)
    console.log('Keep this window open while you use it. Close it to stop.')

    if (shouldOpen) {
      openInBrowser(url)
    }

    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, () => {
        hub.closeAll()
        process.exit(0)
      })
    }

    return
  }

  throw new Error(`Ports ${FIRST_PORT}-${FIRST_PORT + PORT_ATTEMPTS - 1} are all in use.`)
}

main().catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
