/**
 * 动态链接引擎二进制文件的库环境工具。
 *
 * MariaDB、Redis 和 Valkey 的 hostdb 二进制文件链接到 Homebrew 的
 * OpenSSL 绝对路径（例如 /opt/homebrew/opt/openssl@3/lib/libssl.3.dylib）。
 * 在没有该库的系统上，它们会因晦涩的 dyld 错误而失败。
 *
 * 此模块提供：
 * - getLibraryEnv(): 设置 DYLD_FALLBACK_LIBRARY_PATH / LD_LIBRARY_PATH，
 *   使动态链接器首先检查 {binPath}/lib（为 hostdb 将来
 *   与二进制文件一起捆绑 dylib 做准备）。
 * - detectLibraryError(): 扫描进程输出中的库加载模式
 *   并返回可操作的错误消息。
 */

import { platform as osPlatform } from 'os'
import { join } from 'path'

/**
 * 返回指向动态链接器搜索 {binPath}/lib 的环境变量。
 * macOS: DYLD_FALLBACK_LIBRARY_PATH
 * Linux: LD_LIBRARY_PATH
 * Windows: 返回 undefined（不适用）。
 *
 * 用法：展开到 spawn 的 env 中：`{ ...process.env, ...getLibraryEnv(binPath) }`
 */
export function getLibraryEnv(
  binPath: string,
): Record<string, string> | undefined {
  const plat = osPlatform()
  const libDir = join(binPath, 'lib')

  if (plat === 'darwin') {
    return { DYLD_FALLBACK_LIBRARY_PATH: libDir }
  }
  if (plat === 'linux') {
    return { LD_LIBRARY_PATH: libDir }
  }
  return undefined
}

/**
 * 返回将目录添加到 Windows DLL 搜索路径的环境变量。
 * 将目录追加到现有的 PATH 环境变量。
 * 在非 Windows 平台上返回 undefined（不需要）。
 *
 * 用于捆绑了不在默认搜索路径中的子目录 DLL 的引擎
 * （例如 InfluxDB 的 python/ 目录包含加载时需要的 python313.dll）。
 *
 * 用法：展开到 spawn 的 env 中：`{ ...process.env, ...getWindowsDllEnv(dllDir) }`
 */
export function getWindowsDllEnv(
  dllDir: string,
): Record<string, string> | undefined {
  if (osPlatform() !== 'win32') return undefined
  const currentPath = process.env.PATH || ''
  return { PATH: `${currentPath};${dllDir}` }
}

/**
 * 扫描 stderr/日志输出中的动态库加载错误，返回
 * 可操作的消息，如果未检测到库错误则返回 null。
 */
export function detectLibraryError(
  output: string,
  engineName: string,
): string | null {
  if (!output) return null

  const plat = osPlatform()
  const lower = output.toLowerCase()

  // macOS dyld 错误
  if (
    lower.includes('library not loaded') ||
    lower.includes('dyld:') ||
    lower.includes('dyld[')
  ) {
    const needsOpenssl = lower.includes('libssl') || lower.includes('libcrypto')

    if (needsOpenssl && plat === 'darwin') {
      return (
        `${engineName} 启动失败：缺少 OpenSSL 库。\n` +
        `下载的二进制文件需要 OpenSSL 3，但当前未安装。\n` +
        `修复方法：brew install openssl@3\n` +
        `或者，在 hostdb 发布可重定位构建后重新下载二进制文件。`
      )
    }

    return (
      `${engineName} 启动失败：无法加载所需的动态库。\n` +
      `这通常意味着 hostdb 二进制文件所依赖的库在当前系统上不存在。\n` +
      (plat === 'darwin'
        ? `尝试：brew install openssl@3\n`
        : `尝试：sudo apt-get install libssl-dev（或您的发行版对应的等效命令）\n`) +
      `参见：https://github.com/robertjbass/hostdb/issues`
    )
  }

  // Linux GLIBC 版本错误
  if (lower.includes('glibc') || lower.includes('libc.so')) {
    return (
      `${engineName} 启动失败：系统 C 库（GLIBC）版本不兼容。\n` +
      `下载的二进制文件需要的 GLIBC 版本高于已安装的版本。\n` +
      `可选方案：\n` +
      `  - 升级操作系统到更新版本\n` +
      `  - 使用 Docker：SpinDB 可以在具有更新 GLIBC 的容器中运行\n` +
      `参见：https://github.com/robertjbass/hostdb/issues`
    )
  }

  // Linux 通用共享库错误
  if (
    lower.includes('error while loading shared libraries') ||
    lower.includes('cannot open shared object file')
  ) {
    const needsOpenssl = lower.includes('libssl') || lower.includes('libcrypto')

    if (needsOpenssl) {
      return (
        `${engineName} 启动失败：缺少 OpenSSL 库。\n` +
        `修复方法：sudo apt-get install libssl-dev（Debian/Ubuntu）\n` +
        `     sudo dnf install openssl-devel（Fedora/RHEL）\n` +
        `参见：https://github.com/robertjbass/hostdb/issues`
      )
    }

    return (
      `${engineName} 启动失败：缺少所需的共享库。\n` +
      `请检查上方的错误输出以获取具体的库名称并安装。\n` +
      `参见：https://github.com/robertjbass/hostdb/issues`
    )
  }

  return null
}
