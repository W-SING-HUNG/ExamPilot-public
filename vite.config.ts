/// <reference types="vite/client" />
import { defineConfig, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * The AI proxy server (server/index.mjs) is optional. When it is not running the
 * dev server must not turn /api requests into 500s — the frontend handles the
 * failure gracefully and shows an honest "AI unavailable" state.
 *
 * Why the error hook writes JSON instead of letting the socket die
 * ---------------------------------------------------------------
 * Without it axios/http-proxy leaves the browser with a reset connection, which
 * `fetch()` reports as the opaque `TypeError: Failed to fetch`. With it the client
 * always receives a parseable {ok:false} body, so the UI can say "AI 服务端未运行"
 * rather than a message that names nothing.
 *
 * Port note: the target is fixed at 8787 on purpose. `tools/dev.mjs` starts the
 * proxy on 8787 and passes `AI_PORT` to the Vite child, but Vite cannot read a
 * runtime env var from a static config here (this project does not ship
 * @types/node, so `process` is not even typed in this file). If you move the
 * proxy, change it in tools/dev.mjs and here together.
 */
const AI_PROXY_TARGET = 'http://127.0.0.1:8787'

/**
 * CORS for the dev/preview server.
 *
 * Vite's DEFAULT `server.cors` allows ANY localhost / 127.0.0.1 / [::1] origin and
 * echoes it back in `Access-Control-Allow-Origin`. Because `/api` is proxied, that
 * header landed on AI responses too, so an unrelated page on another local port
 * (`http://localhost:8080`) could read `/api/ai/status` and `/api/ai/qa` bodies —
 * widening the surface the backend's own allowlist was meant to bound. (Config
 * WRITES were still refused with 403, so credentials were never at risk.)
 *
 * This app never makes a cross-origin request: every call uses a relative
 * `/api/...` URL against the same server, and same-origin requests involve no CORS
 * at all. So CORS is disabled here rather than left as Vite's permissive default.
 * A genuine cross-origin caller must go through the backend's own
 * `AI_ALLOWED_ORIGINS` allowlist instead of borrowing the dev server's headers.
 */
const DEV_CORS = false

/**
 * Origin handling for the `/api` proxy.
 *
 * The backend can rewrite its gateway credentials (`POST /api/ai/config`), so the
 * request's Origin is a real security boundary, not a formality: anyone who can
 * repoint `baseUrl` receives the real API key on the next AI call.
 *
 * An earlier revision of this file mapped EVERY loopback origin to
 * `http://localhost:5173`. That was a privilege escalation: a page on any other
 * local port (`http://localhost:8080`, an unrelated local app) became a trusted
 * caller and could repoint the gateway. It is fixed here by validating that the
 * Origin is genuinely THIS dev server before treating it as trusted.
 *
 * The rule now:
 *   - Origin present and equal to the request's own Host  -> same-origin page
 *     served by this dev server: normalise to a trusted loopback origin so that a
 *     custom `--port` keeps working.
 *   - Origin present but different                         -> cross-origin page:
 *     forwarded unchanged, and the backend's allowlist rejects it (403).
 *   - No Origin (curl, or a same-origin GET)                -> forwarded untouched;
 *     the backend treats a missing Origin as a local caller.
 *
 * The attack the old code allowed is covered by tests/ai-security.test.mjs.
 */
const TRUSTED_DEV_ORIGIN = 'http://localhost:5173'

const aiProxy: ProxyOptions = {
  target: AI_PROXY_TARGET,
  changeOrigin: true,
  // 屏蔽代理层的 ECONNREFUSED 控制台刷屏；错误统一由下面的 error 钩子以 503 JSON 优雅返回给前端
  ws: false,
  configure(proxy) {
    proxy.on('proxyReq', (proxyReq, req) => {
      const origin = req.headers?.origin
      const host = req.headers?.host
      if (typeof origin !== 'string' || typeof host !== 'string') return

      let sameOrigin = false
      try {
        sameOrigin = new URL(origin).host === host
      } catch {
        sameOrigin = false
      }
      if (!sameOrigin) return // cross-origin: let the backend refuse it

      // Genuinely served by this dev server (any port). Normalise to the origin
      // the backend allowlists so a custom --port does not break configuration.
      proxyReq.setHeader('origin', TRUSTED_DEV_ORIGIN)
    })
    proxy.on('error', (_err, _req, res) => {
      // `res` is the ServerResponse; on a client hang-up it is already destroyed
      // and writing to it throws ERR_STREAM_WRITE_AFTER_END or swallows the error.
      if (!res || typeof res !== 'object' || !('writeHead' in res)) return
      if (res.writableEnded || res.destroyed) return
      if (!res.headersSent) {
        res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      }
      res.end(
        JSON.stringify({
          ok: false,
          configured: false,
          code: 'PROXY_UNAVAILABLE',
          message: `AI 服务端代理未运行（${AI_PROXY_TARGET}）。请运行 npm run server 或直接使用 npm run dev。`,
        }),
      )
    })
  },
}

export default defineConfig({
  plugins: [react()],
  server: {
    cors: DEV_CORS,
    proxy: {
      '/api': aiProxy,
    },
  },
  // `vite preview` uses its own proxy table; without this the built app had no
  // /api route at all and every AI call failed with "Failed to fetch".
  preview: {
    cors: DEV_CORS,
    proxy: {
      '/api': aiProxy,
    },
  },
  build: {
    // The bank JSON is bundled with the app; raise the warning limit accordingly.
    chunkSizeWarningLimit: 900,
  },
  // NOTE: the `test` block that used to live here was removed when Vite moved to
  // v6. Vitest reads `vitest.config.ts` (which has the same — and slightly
  // broader — settings), so the duplicate block was dead configuration. Keeping
  // it also became a type error: `test` is no longer part of Vite's own config
  // type. Behaviour is unchanged; see vitest.config.ts.
})
