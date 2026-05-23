/**
 * 带重试的启动
 *
 * 通过在原始端口在检查和绑定之间变得不可用时自动使用新端口重试，
 * 来处理端口竞争条件。
 */

import { portManager } from './port-manager'
import { containerManager } from './container-manager'
import { logWarning, logDebug } from './error-handler'
import { isPortInUseError } from './fs-error-utils'
import type { BaseEngine } from '../engines/base-engine'
import { getEngineDefaults } from '../config/defaults'
import type { ContainerConfig } from '../types'

export type StartWithRetryOptions = {
  engine: BaseEngine
  config: ContainerConfig
  maxRetries?: number // 默认: 3
  onPortChange?: (oldPort: number, newPort: number) => void
}

export type StartWithRetryResult = {
  success: boolean
  finalPort: number
  retriesUsed: number
  error?: Error
}

/**
 * 启动数据库容器，在端口冲突时自动重试
 *
 * 处理以下竞争条件：端口在检查时可用，
 * 但在数据库服务器尝试绑定时已被占用。
 */
export async function startWithRetry(
  options: StartWithRetryOptions,
): Promise<StartWithRetryResult> {
  const { engine, config, maxRetries = 3, onPortChange } = options

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logDebug(`正在启动 ${engine.name}（第 ${attempt}/${maxRetries} 次尝试）`, {
        containerName: config.name,
        port: config.port,
      })

      await engine.start(config)

      return {
        success: true,
        finalPort: config.port,
        retriesUsed: attempt - 1,
      }
    } catch (error) {
      const isPortError = isPortInUseError(error)

      logDebug(`启动尝试 ${attempt} 失败`, {
        containerName: config.name,
        port: config.port,
        isPortError,
        error: error instanceof Error ? error.message : String(error),
      })

      if (isPortError && attempt < maxRetries) {
        const oldPort = config.port

        // 查找新的可用端口，排除刚刚失败的端口
        const { port: newPort } = await portManager.findAvailablePort({
          portRange: getEnginePortRange(config.engine),
        })

        // 使用新端口更新配置
        config.port = newPort
        await containerManager.updateConfig(config.name, { port: newPort })

        // 通知调用方端口已更改
        if (onPortChange) {
          onPortChange(oldPort, newPort)
        }

        // 记录并重试
        logWarning(
          `端口 ${oldPort} 已被占用，正在使用端口 ${newPort} 重试...`,
        )
        continue
      }

      // 非端口错误或已达到最大重试次数
      return {
        success: false,
        finalPort: config.port,
        retriesUsed: attempt - 1,
        error: error instanceof Error ? error : new Error(String(error)),
      }
    }
  }

  // 理论上不会到达此处，但 TypeScript 需要返回值
  return {
    success: false,
    finalPort: config.port,
    retriesUsed: maxRetries,
    error: new Error('已超过最大重试次数'),
  }
}

/** 获取引擎的端口范围 */
function getEnginePortRange(engine: string): { start: number; end: number } {
  const engineDefaults = getEngineDefaults(engine)
  return engineDefaults.portRange
}

// 简化常见用例的封装
export async function startContainerWithRetry(
  engine: BaseEngine,
  config: ContainerConfig,
  options?: {
    onPortChange?: (oldPort: number, newPort: number) => void
  },
): Promise<void> {
  const result = await startWithRetry({
    engine,
    config,
    onPortChange: options?.onPortChange,
  })

  if (!result.success && result.error) {
    throw result.error
  }
}
