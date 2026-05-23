import { exec, spawn, type SpawnOptions } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { readFile, rm } from 'fs/promises'
import { paths } from '../config/paths'
import { logDebug } from './error-handler'
import {
  platformService,
  isWindows,
  getWindowsSpawnOptions,
} from './platform-service'
import type { ProcessResult, StatusResult } from '../types'

const execAsync = promisify(exec)

export type InitdbOptions = {
  superuser?: string
}

export type StartOptions = {
  port?: number
  logFile?: string
  bindAddress?: string
}

export type PsqlOptions = {
  port: number
  database?: string
  user?: string
  command?: string
}

export type PgRestoreOptions = {
  port: number
  database: string
  user?: string
  format?: string
}

export class ProcessManager {
  async initdb(
    initdbPath: string,
    dataDir: string,
    options: InitdbOptions = {},
  ): Promise<ProcessResult> {
    const { superuser = 'postgres' } = options
    const dirExistedBefore = existsSync(dataDir)

    // 失败时清理数据目录
    const cleanupOnFailure = async () => {
      if (!dirExistedBefore && existsSync(dataDir)) {
        try {
          await rm(dataDir, { recursive: true, force: true })
          logDebug(`initdb 失败后已清理数据目录: ${dataDir}`)
        } catch (cleanupErr) {
          logDebug(
            `清理数据目录失败: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
          )
        }
      }
    }

    if (isWindows()) {
      // 在 Windows 上，将整个命令构建为单个字符串
      const cmd = `"${initdbPath}" -D "${dataDir}" -U ${superuser} --auth=trust --encoding=UTF8 --no-locale`

      logDebug('initdb 命令 (Windows)', { cmd })

      return new Promise((resolve, reject) => {
        exec(cmd, { timeout: 120000 }, async (error, stdout, stderr) => {
          logDebug('initdb 执行完毕', {
            error: error?.message,
            stdout,
            stderr,
          })
          if (error) {
            await cleanupOnFailure()
            reject(
              new Error(
                `initdb 失败，退出码 ${error.code}: ${stderr || stdout || error.message}`,
              ),
            )
          } else {
            resolve({ stdout, stderr })
          }
        })
      })
    }

    // Unix 路径 - 使用 spawn 而不通过 shell
    const args = [
      '-D',
      dataDir,
      '-U',
      superuser,
      '--auth=trust',
      '--encoding=UTF8',
      '--no-locale',
    ]

    logDebug('initdb 命令', { initdbPath, args })

    return new Promise((resolve, reject) => {
      const proc = spawn(initdbPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
      })
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', async (code) => {
        logDebug('initdb 执行完毕', { code, stdout, stderr })
        if (code === 0) {
          resolve({ stdout, stderr })
        } else {
          await cleanupOnFailure()
          reject(new Error(`initdb 失败，退出码 ${code}: ${stderr}`))
        }
      })

      proc.on('error', async (err) => {
        logDebug('initdb 错误', { error: err.message })
        await cleanupOnFailure()
        reject(err)
      })
    })
  }

  async start(
    pgCtlPath: string,
    dataDir: string,
    options: StartOptions = {},
  ): Promise<ProcessResult> {
    const { port, logFile, bindAddress } = options
    const logDest = logFile || platformService.getNullDevice()

    if (isWindows()) {
      // 在 Windows 上，不使用 -w（等待）标志启动，然后轮询就绪状态
      // -w 标志在 Windows 上可能无限挂起
      let cmd = `"${pgCtlPath}" start -D "${dataDir}" -l "${logDest}"`
      const pgOpts: string[] = []
      if (port) pgOpts.push(`-p ${port}`)
      if (bindAddress) pgOpts.push(`-h ${bindAddress}`)
      if (pgOpts.length > 0) {
        cmd += ` -o "${pgOpts.join(' ')}"`
      }

      logDebug('pg_ctl start 命令 (Windows)', { cmd })

      return new Promise((resolve, reject) => {
        exec(cmd, { timeout: 30000 }, async (error, stdout, stderr) => {
          logDebug('pg_ctl start 已发起', {
            error: error?.message,
            stdout,
            stderr,
          })

          if (error) {
            reject(
              new Error(
                `pg_ctl start 失败，退出码 ${error.code}: ${stderr || stdout || error.message}`,
              ),
            )
            return
          }

          // 使用 pg_isready 或状态检查轮询 PostgreSQL 是否就绪
          const statusCmd = `"${pgCtlPath}" status -D "${dataDir}"`
          let attempts = 0
          const maxAttempts = 30
          const pollInterval = 1000

          const checkReady = () => {
            attempts++
            exec(statusCmd, (statusError, statusStdout) => {
              if (!statusError && statusStdout.includes('server is running')) {
                logDebug('pg_ctl start 完成 (Windows)', { attempts })
                resolve({ stdout, stderr })
              } else if (attempts >= maxAttempts) {
                reject(
                  new Error(
                    `PostgreSQL 在 ${maxAttempts} 秒内未能启动`,
                  ),
                )
              } else {
                setTimeout(checkReady, pollInterval)
              }
            })
          }

          // 等待片刻后开始轮询
          setTimeout(checkReady, 500)
        })
      })
    }

    // Unix 路径 - 使用 spawn 而不通过 shell
    const pgOptions: string[] = []
    if (port) {
      pgOptions.push(`-p ${port}`)
    }
    if (bindAddress) {
      pgOptions.push(`-h ${bindAddress}`)
    }

    const args = [
      'start',
      '-D',
      dataDir,
      '-l',
      logDest,
      '-w', // 等待启动完成
      '-t',
      '30', // 30 秒超时
    ]

    if (pgOptions.length > 0) {
      args.push('-o', pgOptions.join(' '))
    }

    logDebug('pg_ctl start 命令', { pgCtlPath, args })

    return new Promise((resolve, reject) => {
      const proc = spawn(pgCtlPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
      })
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        logDebug('pg_ctl start 完成', { code, stdout, stderr })
        if (code === 0) {
          resolve({ stdout, stderr })
        } else {
          reject(
            new Error(
              `pg_ctl start 失败，退出码 ${code}: ${stderr || stdout}`,
            ),
          )
        }
      })

      proc.on('error', (err) => {
        logDebug('pg_ctl start 错误', { error: err.message })
        reject(err)
      })
    })
  }

  async stop(pgCtlPath: string, dataDir: string): Promise<ProcessResult> {
    if (isWindows()) {
      // 在 Windows 上，将整个命令构建为单个字符串
      const cmd = `"${pgCtlPath}" stop -D "${dataDir}" -m fast -w -t 30`

      logDebug('pg_ctl stop 命令 (Windows)', { cmd })

      return new Promise((resolve, reject) => {
        exec(cmd, { timeout: 60000 }, (error, stdout, stderr) => {
          logDebug('pg_ctl stop 完成', {
            error: error?.message,
            stdout,
            stderr,
          })
          if (error) {
            reject(
              new Error(
                `pg_ctl stop 失败，退出码 ${error.code}: ${stderr || stdout || error.message}`,
              ),
            )
          } else {
            resolve({ stdout, stderr })
          }
        })
      })
    }

    // Unix 路径 - 使用 spawn 而不通过 shell
    const args = [
      'stop',
      '-D',
      dataDir,
      '-m',
      'fast',
      '-w', // 等待关闭完成
      '-t',
      '30', // 30 秒超时
    ]

    logDebug('pg_ctl stop 命令', { pgCtlPath, args })

    return new Promise((resolve, reject) => {
      const proc = spawn(pgCtlPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
      })
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        logDebug('pg_ctl stop 完成', { code, stdout, stderr })
        if (code === 0) {
          resolve({ stdout, stderr })
        } else {
          reject(
            new Error(
              `pg_ctl stop 失败，退出码 ${code}: ${stderr || stdout}`,
            ),
          )
        }
      })

      proc.on('error', (err) => {
        logDebug('pg_ctl stop 错误', { error: err.message })
        reject(err)
      })
    })
  }

  async status(pgCtlPath: string, dataDir: string): Promise<StatusResult> {
    const args = ['status', '-D', dataDir]

    try {
      const { stdout } = await execAsync(`"${pgCtlPath}" ${args.join(' ')}`)
      return {
        running: true,
        message: stdout.trim(),
      }
    } catch (error) {
      // pg_ctl status 在服务器未运行时返回非零退出码
      const err = error as { stderr?: string; message: string }
      return {
        running: false,
        message: err.stderr?.trim() || err.message,
      }
    }
  }

  async isRunning(
    containerName: string,
    options: { engine: string },
  ): Promise<boolean> {
    const { engine } = options
    const pidFile = paths.getContainerPidPath(containerName, { engine })
    if (!existsSync(pidFile)) {
      return false
    }

    try {
      const content = await readFile(pidFile, 'utf8')
      const pid = parseInt(content.split('\n')[0], 10)
      process.kill(pid, 0)
      return true
    } catch (error) {
      logDebug('PID 文件检查失败', {
        containerName,
        engine: options.engine,
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  async getPid(
    containerName: string,
    options: { engine: string },
  ): Promise<number | null> {
    const { engine } = options
    const pidFile = paths.getContainerPidPath(containerName, { engine })
    if (!existsSync(pidFile)) {
      return null
    }

    try {
      const content = await readFile(pidFile, 'utf8')
      return parseInt(content.split('\n')[0], 10)
    } catch (error) {
      logDebug('读取 PID 文件失败', {
        pidFile,
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }

  /**
   * 通过 PID 直接终止进程（pg_ctl 不可用时的回退方案）
   * 先发送 SIGTERM，如果进程未停止则发送 SIGKILL
   */
  async killProcess(
    containerName: string,
    options: { engine: string },
  ): Promise<boolean> {
    const pid = await this.getPid(containerName, options)
    if (!pid) {
      // 没有 PID 意味着进程未运行 - 目标已达成
      logDebug('未找到容器的 PID（已停止）', {
        containerName,
      })
      return true
    }

    try {
      // 检查进程是否正在运行
      process.kill(pid, 0)
    } catch {
      // 进程未运行
      logDebug('进程未运行', { containerName, pid })
      return true
    }

    try {
      // 发送 SIGTERM 优雅关闭
      logDebug('向进程发送 SIGTERM', { containerName, pid })
      process.kill(pid, 'SIGTERM')

      // 等待进程停止（最多 10 秒）
      for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setTimeout(resolve, 500))
        try {
          process.kill(pid, 0)
        } catch {
          // 进程已停止
          logDebug('进程已优雅停止', { containerName, pid })
          return true
        }
      }

      // 进程未停止，发送 SIGKILL
      logDebug('向进程发送 SIGKILL', { containerName, pid })
      process.kill(pid, 'SIGKILL')

      // 再等待片刻并验证进程已终止
      await new Promise((resolve) => setTimeout(resolve, 1000))
      try {
        process.kill(pid, 0)
        // SIGKILL 后进程仍在运行（罕见：僵尸进程或不可中断睡眠）
        logDebug('SIGKILL 后进程仍在运行', { containerName, pid })
        return false
      } catch {
        logDebug('进程已通过 SIGKILL 终止', { containerName, pid })
        return true
      }
    } catch (error) {
      logDebug('终止进程失败', {
        containerName,
        pid,
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  async psql(
    psqlPath: string,
    options: PsqlOptions,
  ): Promise<ProcessResult & { code?: number }> {
    const { port, database = 'postgres', user = 'postgres', command } = options

    const args = [
      '-h',
      '127.0.0.1',
      '-p',
      String(port),
      '-U',
      user,
      '-d',
      database,
    ]

    if (command) {
      args.push('-c', command)
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(psqlPath, args, {
        stdio: command ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        ...getWindowsSpawnOptions(),
      })

      if (command) {
        let stdout = ''
        let stderr = ''

        proc.stdout?.on('data', (data: Buffer) => {
          stdout += data.toString()
        })
        proc.stderr?.on('data', (data: Buffer) => {
          stderr += data.toString()
        })

        proc.on('close', (code) => {
          if (code === 0) {
            resolve({ stdout, stderr, code: code ?? undefined })
          } else {
            reject(new Error(`psql 失败，退出码 ${code}: ${stderr}`))
          }
        })
      } else {
        proc.on('close', (code) => {
          resolve({ stdout: '', stderr: '', code: code ?? undefined })
        })
      }

      proc.on('error', reject)
    })
  }

  async pgRestore(
    pgRestorePath: string,
    backupFile: string,
    options: PgRestoreOptions,
  ): Promise<ProcessResult & { code?: number }> {
    const { port, database, user = 'postgres', format } = options

    const args = [
      '-h',
      '127.0.0.1',
      '-p',
      String(port),
      '-U',
      user,
      '-d',
      database,
      '--no-owner',
      '--no-privileges',
    ]

    if (format) {
      args.push('-F', format)
    }

    args.push(backupFile)

    const spawnOptions: SpawnOptions = {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...getWindowsSpawnOptions(),
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(pgRestorePath, args, spawnOptions)

      let stdout = ''
      let stderr = ''

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
      })
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        // pg_restore 即使部分成功也可能返回非零退出码
        resolve({ stdout, stderr, code: code ?? undefined })
      })

      proc.on('error', reject)
    })
  }
}

export const processManager = new ProcessManager()
