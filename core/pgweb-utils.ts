import { existsSync } from 'fs'
import { readFile, unlink } from 'fs/promises'
import { join } from 'path'
import { platformService } from './platform-service'
import { paths } from '../config/paths'

/** 固定的 pgweb 版本号 —— 下载 URL 的唯一来源 */
export const PGWEB_VERSION = '0.17.0'

/**
 * 检查指定容器的 pgweb 是否正在运行。
 * 读取 pgweb.pid/pgweb.port 文件并验证进程是否存活。
 * 如果进程已死亡，则清理过期的 PID/端口文件。
 */
export async function getPgwebStatus(
  containerName: string,
  engine: string,
): Promise<{ running: boolean; port?: number; pid?: number }> {
  const containerDir = paths.getContainerPath(containerName, { engine })
  const pidFile = join(containerDir, 'pgweb.pid')
  const portFile = join(containerDir, 'pgweb.port')

  if (!existsSync(pidFile)) return { running: false }

  try {
    const pid = parseInt(await readFile(pidFile, 'utf8'), 10)
    if (platformService.isProcessRunning(pid)) {
      const port = parseInt(await readFile(portFile, 'utf8'), 10)
      return { running: true, port, pid }
    }
  } catch {
    // PID 文件无效或进程已死亡
  }

  // 清理过期文件
  await unlink(pidFile).catch(() => {})
  await unlink(portFile).catch(() => {})
  return { running: false }
}

/**
 * 停止指定容器的 pgweb 进程（无 UI 输出）。
 * 如果成功停止了进程则返回 true，如果没有运行中的进程则返回 false。
 */
export async function stopPgweb(
  containerName: string,
  engine: string,
): Promise<boolean> {
  const status = await getPgwebStatus(containerName, engine)
  if (!status.running || !status.pid) return false

  try {
    await platformService.terminateProcess(status.pid, false)
  } catch {
    // 进程已不存在
  }

  const containerDir = paths.getContainerPath(containerName, { engine })
  await unlink(join(containerDir, 'pgweb.pid')).catch(() => {})
  await unlink(join(containerDir, 'pgweb.port')).catch(() => {})
  return true
}
