import net from 'net'
import { exec } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { readdir, readFile } from 'fs/promises'
import { defaults, getSupportedEngines } from '../config/defaults'
import { paths } from '../config/paths'
import { logDebug } from './error-handler'
import type { ContainerConfig, PortResult } from '../types'

const execAsync = promisify(exec)

type FindPortOptions = {
  preferredPort?: number
  portRange?: { start: number; end: number }
}

export class PortManager {
  async isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer()

      server.once('error', (err: NodeJS.ErrnoException) => {
        // 始终关闭服务器以防止资源泄漏
        server.close()
        if (err.code === 'EADDRINUSE') {
          resolve(false)
        } else {
          // 其他错误 - 假定端口可用
          resolve(true)
        }
      })

      server.once('listening', () => {
        server.close()
        resolve(true)
      })

      server.listen(port, '127.0.0.1')
    })
  }

  async findAvailablePort(options: FindPortOptions = {}): Promise<PortResult> {
    const preferredPort = options.preferredPort ?? defaults.port
    const portRange = options.portRange ?? defaults.portRange

    // 首先尝试首选端口
    if (await this.isPortAvailable(preferredPort)) {
      return {
        port: preferredPort,
        isDefault: true, // 获取到了首选端口
      }
    }

    // 在范围内扫描可用端口
    for (let port = portRange.start; port <= portRange.end; port++) {
      if (port === preferredPort) continue // 已经尝试过该端口

      if (await this.isPortAvailable(port)) {
        return {
          port,
          isDefault: false,
        }
      }
    }

    throw new Error(
      `在范围 ${portRange.start}-${portRange.end} 内未找到可用端口`,
    )
  }

  async getPortUser(port: number): Promise<string | null> {
    try {
      const { stdout } = await execAsync(`lsof -i :${port} -P -n | head -5`)
      return stdout.trim()
    } catch (error) {
      logDebug('无法确定端口使用者', {
        port,
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }

  async getContainerPorts(): Promise<number[]> {
    const containersDir = paths.containers

    if (!existsSync(containersDir)) {
      return []
    }

    const ports: number[] = []
    const engines = getSupportedEngines()

    for (const engine of engines) {
      const engineDir = paths.getEngineContainersPath(engine)
      if (!existsSync(engineDir)) continue

      const entries = await readdir(engineDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const configPath = paths.getContainerConfigPath(entry.name, {
            engine,
          })
          if (existsSync(configPath)) {
            try {
              const content = await readFile(configPath, 'utf8')
              const config = JSON.parse(content) as ContainerConfig
              // 仅包含运行中容器的端口
              // 已停止的容器不会阻塞端口 - 用户可以自行管理冲突
              if (config.status === 'running') {
                ports.push(config.port)
              }
            } catch (error) {
              logDebug('跳过无效的容器配置', {
                configPath,
                error: error instanceof Error ? error.message : String(error),
              })
            }
          }
        }
      }
    }

    return ports
  }

  async findAvailablePortExcludingContainers(
    options: FindPortOptions = {},
  ): Promise<PortResult> {
    const preferredPort = options.preferredPort ?? defaults.port
    const portRange = options.portRange ?? defaults.portRange
    const containerPorts = await this.getContainerPorts()

    // 首先尝试首选端口
    if (
      !containerPorts.includes(preferredPort) &&
      (await this.isPortAvailable(preferredPort))
    ) {
      return {
        port: preferredPort,
        isDefault: true, // 获取到了首选端口
      }
    }

    // 在范围内扫描可用端口
    for (let port = portRange.start; port <= portRange.end; port++) {
      if (containerPorts.includes(port)) continue // 跳过容器已使用的端口
      if (port === preferredPort) continue // 已经尝试过该端口

      if (await this.isPortAvailable(port)) {
        return {
          port,
          isDefault: false,
        }
      }
    }

    throw new Error(
      `在范围 ${portRange.start}-${portRange.end} 内未找到可用端口`,
    )
  }
}

export const portManager = new PortManager()
