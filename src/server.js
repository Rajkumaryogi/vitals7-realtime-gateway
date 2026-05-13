/**
 * Central realtime gateway — one SSE fan-out for all device connectors.
 *
 * - Browsers: GET /events/:cognitoSub (EventSource), typically via Vite proxy /realtime → this service.
 * - Connectors: POST /internal/publish { userId, type?, source?, data? } + header X-Gateway-Secret
 *
 * Env: PORT, VITALS_REALTIME_GATEWAY_SECRET, REALTIME_SSE_PING_MS, REALTIME_TCP_NODELAY
 */
import express from 'express'
import http from 'http'

const PORT = Number(process.env.PORT || 8095)
const SECRET = process.env.VITALS_REALTIME_GATEWAY_SECRET || 'vitals7-local-dev-realtime'

/** SSE comment ping (ms). 0 = disabled. Shorter = livelier through some proxies; avoid > Node keepAlive gap. */
const rawPing = (process.env.REALTIME_SSE_PING_MS ?? '12000').trim()
let SSE_PING_MS = Number.parseInt(rawPing, 10)
if (!Number.isFinite(SSE_PING_MS) || SSE_PING_MS < 0) SSE_PING_MS = 12000

/** Disable with REALTIME_TCP_NODELAY=0 if you need to coalesce tiny writes (not typical for this service). */
const TCP_NODELAY = !/^0|false|no$/i.test(String(process.env.REALTIME_TCP_NODELAY ?? '1').trim())

/** @type {Map<string, Set<import('http').ServerResponse>>} */
const userClients = new Map()

function allowOrigin(origin) {
    if (!origin) return false
    return (
        /^https?:\/\/localhost(:\d+)?$/i.test(origin) ||
        /^https?:\/\/127\.0\.0\.1(:\d+)?$/i.test(origin) ||
        /^https:\/\/dev-app\.vitals7\.com$/i.test(origin)
    )
}

const app = express()
app.disable('x-powered-by')
app.disable('etag')
app.use(express.json({ limit: '64kb' }))

app.get('/health', (_, res) => {
    res.json({ ok: true, service: 'vitals7-realtime-gateway', clients: userClients.size })
})

app.get('/events/:userId', (req, res) => {
    const { userId } = req.params
    const origin = req.headers.origin
    /** @type {Record<string, string>} */
    const headers = {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    }
    if (allowOrigin(origin)) {
        headers['Access-Control-Allow-Origin'] = origin
        headers.Vary = 'Origin'
    }

    res.writeHead(200, headers)
    if (TCP_NODELAY) {
        const sock = req.socket
        if (sock && typeof sock.setNoDelay === 'function') sock.setNoDelay(true)
    }
    res.write(`data: ${JSON.stringify({ type: 'connected', ts: new Date().toISOString() })}\n\n`)

    if (!userClients.has(userId)) userClients.set(userId, new Set())
    userClients.get(userId).add(res)

    let ping = null
    if (SSE_PING_MS > 0) {
        ping = setInterval(() => {
            try {
                res.write(': ping\n\n')
            } catch {
                /* closed */
            }
        }, SSE_PING_MS)
    }

    req.on('close', () => {
        if (ping) clearInterval(ping)
        const set = userClients.get(userId)
        if (set) {
            set.delete(res)
            if (set.size === 0) userClients.delete(userId)
        }
    })
})

app.post('/internal/publish', (req, res) => {
    if (req.headers['x-gateway-secret'] !== SECRET) {
        return res.status(401).json({ error: 'unauthorized' })
    }
    const { userId, type, source, data } = req.body || {}
    if (!userId) return res.status(400).json({ error: 'userId required' })
    const event = {
        type: type || 'vitals7_refresh',
        source: source || 'unknown',
        data: data ?? null,
        ts: new Date().toISOString(),
    }
    const set = userClients.get(String(userId))
    let delivered = 0
    if (set) {
        const line = `data: ${JSON.stringify(event)}\n\n`
        for (const clientRes of set) {
            try {
                clientRes.write(line)
                delivered++
            } catch {
                /* ignore broken connections */
            }
        }
    }
    res.json({ ok: true, delivered })
})

const server = http.createServer(app)

if (TCP_NODELAY) {
    server.on('connection', (socket) => {
        socket.setNoDelay(true)
    })
}

/** Long-lived SSE: avoid default 5s keep-alive closing streams between infrequent pings. */
const keepMs = SSE_PING_MS > 0 ? Math.max(120_000, SSE_PING_MS * 6) : 120_000
server.keepAliveTimeout = keepMs
server.headersTimeout = Math.max(keepMs, 125_000)

server.listen(PORT, () => {
    console.log(
        `vitals7-realtime-gateway http://localhost:${PORT} (secret: ${SECRET === 'vitals7-local-dev-realtime' ? 'default dev' : 'custom'}, tcpNoDelay: ${TCP_NODELAY}, ssePingMs: ${SSE_PING_MS})`
    )
})
