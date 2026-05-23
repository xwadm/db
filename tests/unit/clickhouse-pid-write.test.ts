/**
 * ClickHouse PID 写入竞态的回归测试。
 *
 * Bug: spindb 的 ClickHouse engine.start() 仅在 waitForReady 成功后
 * 写入守护进程 PID 文件。当就绪探测超时（低内存云容器上为 240 秒）或
 * findProcessByPort 出现问题时，守护进程仍在运行但没有 PID 文件。
 * spindb 随后将容器报告为"已停止"（没有 PID 文件 → process-manager.isRunning
 * 返回 false），云的健康协调器将数据库行翻转为已停止状态，尽管守护进程仍在运行。
 *
 * 修复: writePidFromPort() 现在在 waitForReady 之前调用，并在之后再次调用，
 * 因此只要守护进程曾经绑定端口，PID 文件就会被写入 —— 独立于就绪握手。
 *
 * 这些测试在不启动真实 ClickHouse 服务器的情况下验证辅助函数本身。
 * 它们使用裸 TCP 监听器作为守护进程端口绑定状态的替代，
 * 因为 findProcessByPort 只是通过 `lsof -ti` 查看谁拥有 TCP 套接字。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'net'
import { existsSync } from 'fs'
import { mkdir, readFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { ClickHouseEngine } from '../../engines/clickhouse/index'

const engine = new ClickHouseEngine()

let testDir: string

function listenOnEphemeralPort(): Promise<{ port: number; server: Server }> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address === 'object' && address) {
        resolve({ port: address.port, server })
      } else {
        reject(new Error('No address bound'))
      }
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve())
  })
}

describe('ClickHouse writePidFromPort (BUG-2 回归测试)', () => {
  before(async () => {
    testDir = join(tmpdir(), `spindb-ch-pidwrite-${Date.now()}`)
    await mkdir(testDir, { recursive: true })
  })

  after(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {})
  })

  it('当进程绑定到端口时将监听进程 PID 写入文件', async () => {
    const { port, server } = await listenOnEphemeralPort()
    const pidFile = join(testDir, `bound-${port}.pid`)
    try {
      const wrote = await engine.writePidFromPort(port, pidFile, {
        maxAttempts: 3,
        intervalMs: 50,
      })
      assert.equal(wrote, true, '应报告 PID 文件已写入')
      assert.equal(
        existsSync(pidFile),
        true,
        'PID 文件应存在于磁盘上',
      )
      const contents = (await readFile(pidFile, 'utf8')).trim()
      assert.match(contents, /^\d+$/, 'PID 文件应包含数字 PID')
      // lsof 抓取可能返回任何持有端口的进程 —— 至少
      // 它应该是一个我们可以通过信号零验证的有效 PID。
      // （在 macOS 上 lsof 报告 Node 测试进程；在 Linux CI 上相同。）
      // 只需检查它不是零或负数。
      assert.ok(
        Number(contents) > 0,
        `PID 应为正数，得到: ${contents}`,
      )
    } finally {
      await closeServer(server)
    }
  })

  it('当端口上没有监听时返回 false 且不创建文件', async () => {
    // 选择一个临时端口并立即关闭，确保上面没有进程。
    const { port, server } = await listenOnEphemeralPort()
    await closeServer(server)

    const pidFile = join(testDir, `unbound-${port}.pid`)
    const wrote = await engine.writePidFromPort(port, pidFile, {
      maxAttempts: 2,
      intervalMs: 25,
    })
    assert.equal(wrote, false, '应报告 PID 文件未写入')
    assert.equal(
      existsSync(pidFile),
      false,
      '当没有进程持有端口时不应创建 PID 文件',
    )
  })

  it('尊重 maxAttempts 和 intervalMs（有界重试，不挂起）', async () => {
    const { port, server } = await listenOnEphemeralPort()
    await closeServer(server)

    const pidFile = join(testDir, `bounded-${port}.pid`)
    const started = Date.now()
    const wrote = await engine.writePidFromPort(port, pidFile, {
      maxAttempts: 4,
      intervalMs: 50,
    })
    const elapsed = Date.now() - started

    assert.equal(wrote, false)
    // 4 次尝试，间隔 50ms = 最多约 3 次 50ms 的休眠 = 约 150ms 最小值
    // 加上每次尝试的 lsof 执行开销。限制在 5 秒内以捕获无限循环回归。
    assert.ok(
      elapsed < 5000,
      `writePidFromPort 应有界；耗时 ${elapsed}ms`,
    )
  })
})
