/**
 * 针对 TigerBeetle 启动竞争条件（BUG-7）的回归测试。
 *
 * 修复前的症状：
 *   - `tigerbeetle.test.ts` 集成测试套件在 macOS arm64、macOS x64
 *     和 Windows x64 的 CI 运行中大约有 25% 的概率出现随机失败。
 *   - 失败模式：
 *       (a) "Failed to format TigerBeetle data file: ETIMEDOUT" ——
 *           `tigerbeetle format` 子进程在冷/繁忙的 CI 磁盘上分配
 *           1.06 GiB 数据文件所需时间超过了之前的 30 秒预算。
 *       (b) "TigerBeetle failed to start within timeout" —— 就绪探针
 *           使用了 `portManager.isPortAvailable`，它可能在守护进程
 *           接受连接之前就触发；后续的连接操作因此竞争并观察到
 *           ECONNREFUSED。
 *       (c) 在格式化成功但元数据尚未刷盘之前，后续的 `start()` 看到
 *           缺失/空的数据文件并中止。
 *
 * 修复位于 `engines/tigerbeetle/index.ts`：
 *   - `initDataDir` 以异步方式运行格式化，预算为 120 秒，并在返回前
 *     等待数据文件可见且非空。
 *   - `start()` 重试数据文件存在性检查，使用 TCP 连接进行就绪检测
 *     （以端口绑定作为后备），并将“端口上有监听者”视为就绪，
 *     即使在就绪探针超时的情况下也是如此——这借鉴了 ClickHouse PID
 *     竞争修复的思路。
 *
 * 这些测试在不启动真实 TigerBeetle 守护进程的情况下，对竞争修复引入的
 * 两个纯辅助函数（`waitForDataFileReady` 和 `waitForReady`）进行验证。
 * 它们可防止未来的回归导致超时或轮询语义被回退。
 */
import { describe, it, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'net'
import { mkdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { TigerBeetleEngine } from '../../engines/tigerbeetle/index'

const engine = new TigerBeetleEngine()

let testDir: string

function listenOnEphemeralPort(): Promise<{ port: number; server: Server }> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      // 不响应任何内容；仅接受连接以完成 TCP 握手。
      socket.destroy()
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address === 'object' && address) {
        resolve({ port: address.port, server })
      } else {
        reject(new Error('未绑定地址'))
      }
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve())
  })
}

describe('TigerBeetle waitForDataFileReady（BUG-7 回归测试）', () => {
  before(async () => {
    testDir = join(tmpdir(), `spindb-tb-startup-race-${Date.now()}`)
    await mkdir(testDir, { recursive: true })
  })

  after(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {})
  })

  it('一旦数据文件存在且非空，则返回 true', async () => {
    const dataFile = join(testDir, 'visible.tigerbeetle')
    // 在探针启动前写入一个字节，模拟“格式化完成且已刷盘”的状态。
    await writeFile(dataFile, Buffer.from([0]))

    const ready = await engine.waitForDataFileReady(dataFile, {
      maxAttempts: 5,
      intervalMs: 25,
    })
    assert.equal(ready, true, '应观察到数据文件已就绪')
  })

  it('当文件在轮询期间出现（延迟刷盘）时，返回 true', async () => {
    const dataFile = join(testDir, 'delayed.tigerbeetle')

    // 安排文件在几个轮询周期后出现。
    setTimeout(() => {
      writeFile(dataFile, Buffer.alloc(64)).catch(() => {})
    }, 80)

    const ready = await engine.waitForDataFileReady(dataFile, {
      maxAttempts: 20,
      intervalMs: 25,
    })
    assert.equal(ready, true, '应在刷盘完成后检测到数据文件')
  })

  it('当数据文件从未出现时，返回 false（有界重试）', async () => {
    const dataFile = join(testDir, 'missing.tigerbeetle')

    const started = Date.now()
    const ready = await engine.waitForDataFileReady(dataFile, {
      maxAttempts: 4,
      intervalMs: 25,
    })
    const elapsed = Date.now() - started

    assert.equal(ready, false, '在达到最大尝试次数后应报告未就绪')
    // 4 次尝试 × 每次间隔 25 毫秒 ≈ 75 毫秒；上限设为 2 秒，
    // 以便在慢速 CI 运行器上检测无限循环回归。
    assert.ok(
      elapsed < 2000,
      `waitForDataFileReady 应是有界的；耗时 ${elapsed} 毫秒`,
    )
  })

  it('当数据文件存在但为空（部分格式化）时，返回 false', async () => {
    const dataFile = join(testDir, 'empty.tigerbeetle')
    await writeFile(dataFile, Buffer.alloc(0))

    const ready = await engine.waitForDataFileReady(dataFile, {
      maxAttempts: 3,
      intervalMs: 25,
    })
    assert.equal(ready, false, '空数据文件不算“就绪”——TigerBeetle 会拒绝启动')
  })
})

describe('TigerBeetle waitForReady（BUG-7 回归测试）', () => {
  const servers: Server[] = []

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop()
      if (server) await closeServer(server)
    }
  })

  it('当端口上有真实监听者时，通过 TCP 连接返回 true', async () => {
    const { port, server } = await listenOnEphemeralPort()
    servers.push(server)

    const ready = await engine.waitForReady(port, 5_000)
    assert.equal(ready, true, '应完成与桩监听者的 TCP 握手')
  })

  it('当端口上无任何监听时，返回 false（有界预算）', async () => {
    const { port, server } = await listenOnEphemeralPort()
    // 立即关闭，使端口上无任何监听。
    await closeServer(server)

    const started = Date.now()
    const ready = await engine.waitForReady(port, 800)
    const elapsed = Date.now() - started

    assert.equal(ready, false)
    // 应在约 800 毫秒后放弃，不应挂起。为慢速 CI 运行器
    // （Windows lsof/connect 开销）留出充足余量。
    assert.ok(
      elapsed < 5000,
      `waitForReady 应遵守其超时预算；耗时 ${elapsed} 毫秒`,
    )
  })

  it('当监听者在轮询期间绑定（初始探针失败，重试成功）时，返回 true', async () => {
    const { port, server: stub } = await listenOnEphemeralPort()
    await closeServer(stub)

    let realServer: Server | null = null
    setTimeout(async () => {
      try {
        realServer = createServer((socket) => socket.destroy())
        await new Promise<void>((resolve, reject) => {
          realServer!.once('error', reject)
          realServer!.listen(port, '127.0.0.1', () => resolve())
        })
        servers.push(realServer)
      } catch {
        // 如果在此 CI 运行器上端口不可用，下面的断言自然会失败——
        // 不会导致无限挂起。
      }
    }, 200)

    const ready = await engine.waitForReady(port, 5_000)
    assert.equal(ready, true, '应接受在首次探针之后绑定的监听者')
  })
})
