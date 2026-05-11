/**
 * Central realtime gateway — one SSE fan-out for all device connectors.
 *
 * - Browsers: GET /events/:cognitoSub (EventSource), typically via Vite proxy /realtime → this service.
 * - Connectors: POST /internal/publish { userId, type?, source?, data? } + header X-Gateway-Secret
 *
 * Env: PORT (default 8095), VITALS_REALTIME_GATEWAY_SECRET (default vitals7-local-dev-realtime)
 */
import express from 'express'
import http from 'http'

const PORT = Number(process.env.PORT || 8095)
const SECRET = process.env.VITALS_REALTIME_GATEWAY_SECRET || 'vitals7-local-dev-realtime'

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
app.use(express.json({ limit: '256kb' }))

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
    res.write(`data: ${JSON.stringify({ type: 'connected', ts: new Date().toISOString() })}\n\n`)

    if (!userClients.has(userId)) userClients.set(userId, new Set())
    userClients.get(userId).add(res)

    const ping = setInterval(() => {
        try {
            res.write(': ping\n\n')
        } catch {
            /* closed */
        }
    }, 25000)

    req.on('close', () => {
        clearInterval(ping)
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

http.createServer(app).listen(PORT, () => {
    console.log(`vitals7-realtime-gateway http://localhost:${PORT} (secret: ${SECRET === 'vitals7-local-dev-realtime' ? 'default dev' : 'custom'})`)
})