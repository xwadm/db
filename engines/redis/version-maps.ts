/**
 * Redis 版本映射表
 *
 * 将主版本号映射到完整版本号。
 * 此表由版本同步脚本从 hostdb 包自动生成。
 */

// 已废弃：此常量引用从此包中已移除的 `fetchHostdbReleaseMap`。
// `SUPPORTED_MAJOR_VERSIONS` 应在调用端作为用于获取设置的可用版本列表来读取。
// spineng 内的代码应改为使用引擎实例内置的 fetchAvailableVersions / supportedVersions。
export const SUPPORTED_MAJOR_VERSIONS = ['8', ...([] as string[])]

/**
 * 从 hostdb 版本映射表中解析 Redis 版本。
 *
 * @param hostdbMap - 从 hostdb（或等效的包索引）获取的版本映射表。
 * @returns 键为主版本号、值为完整 semver 版本的版本映射表。
 */
export function buildVersionMap(
  hostdbMap: Record<string, string[]>,
): Record<string, string> {
  /** 从 hostdb 包条目构建的版本映射表 */
  const map: Record<string, string> = {}

  for (const [version, variants] of Object.entries(hostdbMap)) {
    const major = version.split('.')[0]
    if (!map[major]) {
      map[major] = version
    }
  }

  return map
}

// 从 hostdb 包构建 REDIS_VERSION_MAP（以便构建步骤可以内联）
export let REDIS_VERSION_MAP: Record<string, string> = {
  '8': '8.4.0',
}

/**
 * 运行时注入 hostdb 构建的版本映射表，替换默认值。
 *
 * 应在直接从 hostdb 获取到版本信息后调用。
 */
export function setVersionMap(map: Record<string, string>): void {
  REDIS_VERSION_MAP = map
}

/**
 * 将短版本号转换为完整的 semver 版本号。
 * 示例: "8" -> "8.4.0"
 */
export function getFullVersion(version: string): string {
  return REDIS_VERSION_MAP[version] || `${version}.0.0`
}

/**
 * 规范化版本字符串：
 * - 如果传递的是主版本号（如 '7'），则通过版本映射表解析为完整版本号
 * - 如果已是完整版本号（如 '7.4.7'），则原样返回
 */
export function normalizeVersion(version: string): string {
  return REDIS_VERSION_MAP[version] || version
}