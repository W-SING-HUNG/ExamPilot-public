#!/usr/bin/env node
/**
 * ExamPilot 一键启动统一入口脚本
 *
 * 职责：
 * 1. 题库检查：自动执行 bank:ensure（存在私有题库加载私有题库，无私有题库加载示例题库）
 * 2. 状态检测与端口复用：
 *    - 检测 AI 代理服务（8787）：若已运行则直接复用，若未运行则启动 server/index.mjs
 *    - 检测 Vite 前端（5173）：若已运行则提示复用并打印地址，若未运行则启动 Vite
 * 3. 进程生命周期托管与优雅退出：
 *    - 捕获 SIGINT / SIGTERM / SIGHUP / exit 事件以及 Windows 下的 stdin 关闭
 *    - 退出时准确仅清理本次启动创建的子进程，绝不误杀已有服务或其他无关进程
 * 4. 本地回环绑定与安全隔离：
 *    - 环境变量锁定 AI_HOST=127.0.0.1，只监听本机，不暴露网络
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const VITE_PORT = Number(process.env.PORT || 5173)
const AI_PORT = Number(process.env.AI_PORT || 8787)
const HOST = '127.0.0.1'

// 记录由本次进程实际启动的子进程
const managedChildren = []

/** 检测指定 TCP 端口是否已有监听服务（同时检测 127.0.0.1 和 ::1/localhost） */
function checkPortInUse(port) {
  return new Promise((resolve) => {
    let resolved = false
    const done = (val) => {
      if (!resolved) {
        resolved = true
        resolve(val)
      }
    }

    const testHost = (h) => {
      const socket = new net.Socket()
      socket.setTimeout(800)
      socket.once('connect', () => {
        socket.destroy()
        done(true)
      })
      socket.once('timeout', () => {
        socket.destroy()
      })
      socket.once('error', () => {
        // ignore single host error
      })
      socket.connect(port, h)
    }

    testHost('127.0.0.1')
    testHost('::1')
    testHost('localhost')

    setTimeout(() => {
      done(false)
    }, 1000)
  })
}

/** 检测 AI 服务端代理是否健康响应 */
function checkAiProxyHealthy(port = AI_PORT) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: HOST,
        port,
        path: '/api/ai/status',
        timeout: 1500,
      },
      (res) => {
        // Drain the body so the socket can be released.
        res.resume()
        resolve(res.statusCode === 200)
      },
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}

/**
 * Check whether the process listening on AI_PORT is really our AI proxy.
 * A stale unrelated process on 8787 used to be silently reused: the plan says
 * "端口已占用但未正常响应" and then continues, which leaves Vite proxying /api to
 * a socket that will never answer — the browser then shows "Failed to fetch".
 */
async function diagnoseAiPort() {
  const healthy = await checkAiProxyHealthy(AI_PORT)
  if (healthy) return 'healthy'
  return 'occupied-unhealthy'
}

/** 执行一次题库确保检查 */
async function runBankEnsure() {
  console.log('[ExamPilot 启动器] 正在检查题库加载状态...')
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'bank-local.mjs'), '--ensure'], {
      cwd: ROOT,
      stdio: 'inherit',
      env: process.env,
    })
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`题库加载检查退出码非 0: ${code}`))
    })
    child.on('error', reject)
  })
}

/** 启动 AI 服务子进程 */
async function startAiServer() {
  const inUse = await checkPortInUse(AI_PORT)
  if (inUse) {
    const state = await diagnoseAiPort()
    if (state === 'healthy') {
      console.log(`[ExamPilot 启动器] AI 后端已在 http://${HOST}:${AI_PORT} 运行，自动复用已有服务。`)
      return
    }
    // Do NOT continue silently: Vite would keep proxying /api to a port that
    // accepts connections but never answers the AI protocol, and every AI request
    // (including 保存配置) would fail in a way the UI cannot explain.
    console.error(
      `[ExamPilot 启动器] 端口 ${AI_PORT} 已被占用，但该端口上的服务没有响应 /api/ai/status。\n` +
        '  为避免把 /api 代理到一个不工作的后端，启动已中止。\n' +
        `  请关闭占用 ${AI_PORT} 的程序，或设置 AI_PORT 指定其他端口。`,
    )
    process.exit(1)
  }

  console.log(`[ExamPilot 启动器] 正在启动 AI 服务端代理 (http://${HOST}:${AI_PORT})...`)
  const aiProcess = spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], {
    cwd: ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...process.env,
      AI_HOST: HOST,
      AI_PORT: String(AI_PORT),
    },
    detached: false,
  })

  managedChildren.push({ name: 'AI 后端代理', proc: aiProcess })

  aiProcess.on('exit', (code, signal) => {
    if (signal) {
      console.log(`[ExamPilot 启动器] AI 后端服务已终止 (信号: ${signal})`)
    } else if (code !== null && code !== 0) {
      console.error(`[ExamPilot 启动器] AI 后端服务异常退出，退出码: ${code}`)
    }
  })

  // 等待 AI 服务端口就绪（并确认它真的在跑我们的协议，而不只是端口被占用）
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100))
    if (await checkAiProxyHealthy(AI_PORT)) {
      console.log(`[ExamPilot 启动器] AI 服务端代理已就绪 (http://${HOST}:${AI_PORT})`)
      return
    }
    if (aiProcess.exitCode !== null) {
      console.error('[ExamPilot 启动器] AI 服务端代理启动失败，请查看上方错误输出。')
      process.exit(1)
    }
  }
  console.error(`[ExamPilot 启动器] AI 服务端代理在 5 秒内未就绪（${HOST}:${AI_PORT}），请检查端口占用与配置。`)
}

/** 启动 Vite 前端服务 */
async function startViteFrontend() {
  const inUse = await checkPortInUse(VITE_PORT)
  if (inUse) {
    console.log(`[ExamPilot 启动器] 前端服务端口 ${VITE_PORT} 已在使用中。可以直接访问：http://localhost:${VITE_PORT}`)
    return
  }

  console.log(`[ExamPilot 启动器] 正在启动前端开发服务 (http://localhost:${VITE_PORT})...`)
  const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
  // Vite must be told the port explicitly: without --port it always binds 5173 and silently
  // falls back to 5174 when 5173 is taken, which contradicted the address printed above.
  const viteProcess = spawn(process.execPath, [viteBin, '--port', String(VITE_PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
    detached: false,
  })

  managedChildren.push({ name: 'Vite 前端', proc: viteProcess })

  viteProcess.on('exit', (code, signal) => {
    if (signal) {
      console.log(`[ExamPilot 启动器] Vite 前端已终止 (信号: ${signal})`)
    } else if (code !== null && code !== 0) {
      console.error(`[ExamPilot 启动器] Vite 前端退出，退出码: ${code}`)
    }
    // 前端关闭时，触发主进程清理退出
    cleanupAndExit(code || 0)
  })
}

let isCleaningUp = false
function cleanupAndExit(code = 0) {
  if (isCleaningUp) return
  isCleaningUp = true

  console.log('\n[ExamPilot 启动器] 正在关闭服务并清理子进程...')
  for (const { name, proc } of managedChildren) {
    if (proc && !proc.killed && proc.exitCode === null) {
      try {
        console.log(`[ExamPilot 启动器] 正在停止 ${name} (PID: ${proc.pid})...`)
        // Windows 下先尝试 SIGTERM，如果不支持则 kill
        proc.kill('SIGTERM')
      } catch {
        try {
          proc.kill()
        } catch {
          // ignore
        }
      }
    }
  }

  setTimeout(() => {
    process.exit(code)
  }, 300)
}

// 注册退出信号捕获
process.on('SIGINT', () => cleanupAndExit(0))
process.on('SIGTERM', () => cleanupAndExit(0))
process.on('SIGHUP', () => cleanupAndExit(0))
process.on('exit', () => cleanupAndExit(0))

// 兼容 Windows 控制台中断
if (process.stdin.isTTY) {
  process.stdin.setEncoding('utf-8')
  process.stdin.on('data', (key) => {
    // Ctrl+C in raw mode or EOF
    if (key === '\u0003') cleanupAndExit(0)
  })
}

// 主流程启动
async function main() {
  try {
    await runBankEnsure()
    await startAiServer()
    await startViteFrontend()
  } catch (err) {
    console.error(`[ExamPilot 启动器] 启动失败:`, err)
    cleanupAndExit(1)
  }
}

main()
