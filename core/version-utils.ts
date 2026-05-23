/**
 * 共享的版本比较工具
 *
 * 提供健壮的版本比较功能，处理预发布后缀
 * 如 "11.8.0-rc1" 或 "7.4.7-beta2"。
 */

/**
 * 将版本段解析为数字前缀和后缀
 *
 * 期望格式: 可选数字后跟可选后缀
 * 示例:
 *   "7"     -> { num: 7, suffix: "" }
 *   "7-rc1" -> { num: 7, suffix: "-rc1" }
 *   "0"     -> { num: 0, suffix: "" }
 *
 * 非数字段（无前导数字）:
 *   "abc"   -> { num: -1, suffix: "abc" }
 *   ""      -> { num: -1, suffix: "" }
 *
 * 使用 num === -1 检测非数字段。比较版本时，
 * 非数字段排在数字段之前（因为 -1 < 0）。
 *
 * @param segment - 单个版本段（点之间的部分）
 * @returns 包含数字前缀和剩余后缀的对象
 */
export function parseVersionSegment(segment: string): {
  num: number
  suffix: string
} {
  const match = segment.match(/^(\d+)(.*)$/)
  if (!match) {
    // 非数字段: 使用 -1 作为哨兵值以便调用者区分
    return { num: -1, suffix: segment }
  }
  return { num: parseInt(match[1], 10), suffix: match[2] }
}

/**
 * 比较两个版本字符串（例如 "11.8.5" 与 "11.8.4"）
 * 处理预发布后缀如 "11.8.0-rc1" - 空后缀排在预发布之后
 * 返回正值表示 a > b，负值表示 a < b，0 表示相等
 */
export function compareVersions(a: string, b: string): number {
  const partsA = a.split('.')
  const partsB = b.split('.')

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const segA = parseVersionSegment(partsA[i] || '0')
    const segB = parseVersionSegment(partsB[i] || '0')

    // 先比较数字部分
    if (segA.num !== segB.num) {
      return segA.num - segB.num
    }

    // 数字部分相等时，比较后缀
    // 空后缀（正式版）> 预发布后缀（例如 "-rc1"）
    if (segA.suffix !== segB.suffix) {
      if (segA.suffix === '') return 1 // a 是正式版，b 是预发布版
      if (segB.suffix === '') return -1 // b 是正式版，a 是预发布版
      // 注意：字典序比较意味着 -rc10 < -rc2（对数字后缀不正确）。
      // 这对于使用单位数预发布的 hostdb 版本是可以接受的。
      // 如果需要多位数预发布，请单独解析数字后缀。
      return segA.suffix.localeCompare(segB.suffix)
    }
  }
  return 0
}

/**
 * 检查 versionA 是否比 versionB 更新
 * compareVersions 的便捷封装
 */
export function isNewerVersion(versionA: string, versionB: string): boolean {
  return compareVersions(versionA, versionB) > 0
}

/**
 * 验证类 semver 版本字符串的正则表达式模式。
 * 匹配: X、X.Y 或 X.Y.Z，其中每个组件为数字。
 * 示例: "8", "8.0", "8.0.40", "17", "17.7.0"
 */
export const SEMVER_LIKE_PATTERN = /^\d+(\.\d+){0,2}$/

/**
 * 验证版本字符串是否符合类 semver 格式（X、X.Y 或 X.Y.Z）。
 * 用于需要严格版本格式验证的引擎（MySQL、PostgreSQL）。
 *
 * @param version - 要验证的版本字符串
 * @param engineName - 错误消息中的引擎名称（例如 'MySQL', 'PostgreSQL'）
 * @throws 如果版本格式无效则抛出 TypeError
 */
export function validateSemverLikeVersion(
  version: string,
  engineName: string,
): void {
  if (!SEMVER_LIKE_PATTERN.test(version)) {
    throw new TypeError(
      `无效的 ${engineName} 版本格式: "${version}"。` +
        `期望格式: X、X.Y 或 X.Y.Z（例如 "8"、"8.0"、"8.0.40"）`,
    )
  }
}

/**
 * 如果版本字符串是简写形式（非完整的 X.Y.Z 格式），则返回 true。
 *
 * 由 `spindb start` 用于检测早于即时解析（A9）的 container.version 条目，
 * 并自动将它们迁移为完整形式，使容器不再受版本漂移影响。
 *
 * 处理:
 *   - 1 段简写: '17', '8'
 *   - 2 段简写: '8.4', '11.8', '25.12'
 *   - 复合简写: '17'（postgresql-documentdb v1 后端）
 *   - 跳过完整 3 段 semver: '17.10.0', '11.8.6'
 *   - 跳过 4 段 ClickHouse semver: '25.12.3.21'
 *   - 跳过复合完整形式: '17-0.107.0'
 *
 * 对于已经是固定完整形式或非版本哨兵值（如 'unknown'）的字符串返回 false
 * （这些由调用者处理）。
 */
export function isShorthandVersion(version: string): boolean {
  if (!version || version === 'unknown') return false

  // 复合格式（postgresql-documentdb）: `<pg-major>-<docdb-version>` 如
  // `17-0.107.0`。同时存在 `-` 和点分后缀意味着它是完整的固定形式。
  // 纯 `17`（完全没有 `-`）由下面的普通 semver 分支处理为简写。
  // 带有但无后缀点的连字符（理论上的例如 `17-rc1`）仍然是简写 ——
  // 因为没有补丁组件。
  if (version.includes('-')) {
    const [, suffix = ''] = version.split('-', 2)
    return !suffix.includes('.')
  }

  // 普通 semver-like: 1 段 `17` / 2 段 `8.4` 是简写;
  // 3 段 `17.10.0` 和 4 段 ClickHouse `25.12.3.21` 是完整形式。
  const parts = version.split('.')
  return parts.length < 3
}
