/**
 * 文件系统错误工具
 *
 * 用于文件系统操作的共享错误检测和文件操作函数。
 */

import { rename, cp, rm } from 'fs/promises'
import { logDebug } from './error-handler'

/**
 * 检查是否为应触发 cp 回退的文件系统错误
 * - EXDEV: 跨设备链接（跨文件系统重命名）
 * - EPERM: 权限错误（Windows 文件系统操作）
 * - ENOTEMPTY: 目录非空（目标已存在内容）
 */
export function isRenameFallbackError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as NodeJS.ErrnoException).code
  return (
    typeof code === 'string' && ['EXDEV', 'EPERM', 'ENOTEMPTY'].includes(code)
  )
}

/**
 * 将文件或目录从源路径移动到目标路径。
 * 使用 rename() 以提高效率，对于跨设备移动、权限问题或
 * 非空目标目录（EXDEV、EPERM、ENOTEMPTY）回退到 cp() + rm()。
 *
 * @param sourcePath - 源文件或目录路径
 * @param destPath - 目标文件或目录路径
 */
export async function moveEntry(
  sourcePath: string,
  destPath: string,
): Promise<void> {
  try {
    await rename(sourcePath, destPath)
  } catch (error) {
    if (isRenameFallbackError(error)) {
      await cp(sourcePath, destPath, { recursive: true, force: true })
      // 尝试清理源文件，但如果失败不报错
      // （目标已成功创建）
      try {
        await rm(sourcePath, { recursive: true, force: true })
      } catch (cleanupError) {
        logDebug('复制后清理源文件失败', {
          sourcePath,
          destPath,
          error:
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError),
        })
      }
    } else {
      throw error
    }
  }
}

/**
 * 检查错误是否表示端口已被占用
 */
export function isPortInUseError(error: unknown): boolean {
  if (!(error instanceof Error)) return false

  // 首先检查错误码（比消息解析更可靠）
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'EADDRINUSE') {
    return true
  }

  // 回退到基于消息的检测
  const message = error.message.toLowerCase()
  return (
    message.includes('address already in use') ||
    message.includes('eaddrinuse') ||
    (message.includes('port') && message.includes('in use')) ||
    message.includes('could not bind') ||
    message.includes('socket already in use')
  )
}
