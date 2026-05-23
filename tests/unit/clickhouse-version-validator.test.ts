import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseVersion,
  compareVersions,
  getMajorVersion,
  getMajorMinorPatchVersion,
  isVersionSupported,
  isVersionCompatible,
  isValidVersionFormat,
} from '../../engines/clickhouse/version-validator'

// =============================================================================
// parseVersion 测试
// ClickHouse 使用 YY.MM.X.build 版本控制（例如 25.12.3.21）
// =============================================================================

describe('ClickHouse parseVersion', () => {
  describe('标准版本字符串', () => {
    it('应解析完整的四部分版本', () => {
      const result = parseVersion('25.12.3.21')
      assert.notEqual(result, null)
      assert.equal(result?.year, 25)
      assert.equal(result?.month, 12)
      assert.equal(result?.patch, 3)
      assert.equal(result?.build, 21)
      assert.equal(result?.raw, '25.12.3.21')
    })

    it('应解析三部分版本', () => {
      const result = parseVersion('25.12.3')
      assert.notEqual(result, null)
      assert.equal(result?.year, 25)
      assert.equal(result?.month, 12)
      assert.equal(result?.patch, 3)
      assert.equal(result?.build, 0)
    })

    it('应解析两部分版本', () => {
      const result = parseVersion('25.12')
      assert.notEqual(result, null)
      assert.equal(result?.year, 25)
      assert.equal(result?.month, 12)
      assert.equal(result?.patch, 0)
      assert.equal(result?.build, 0)
    })
  })

  describe('带前缀的版本', () => {
    it('应处理带小写 "v" 前缀的版本', () => {
      const result = parseVersion('v25.12.3.21')
      assert.notEqual(result, null)
      assert.equal(result?.year, 25)
      assert.equal(result?.month, 12)
    })

    it('应处理带空格的版本', () => {
      const result = parseVersion('  25.12.3  ')
      assert.notEqual(result, null)
      assert.equal(result?.year, 25)
      assert.equal(result?.month, 12)
    })
  })

  describe('错误处理', () => {
    it('对单个数字应返回 null', () => {
      const result = parseVersion('25')
      assert.equal(result, null)
    })

    it('对空字符串应返回 null', () => {
      const result = parseVersion('')
      assert.equal(result, null)
    })

    it('对非数字版本应返回 null', () => {
      const result = parseVersion('abc.def')
      assert.equal(result, null)
    })
  })
})

// =============================================================================
// compareVersions 测试
// =============================================================================

describe('ClickHouse compareVersions', () => {
  it('对相等版本应返回 0', () => {
    assert.equal(compareVersions('25.12.3.21', '25.12.3.21'), 0)
  })

  it('当第一个较旧时（年份）应返回 -1', () => {
    assert.equal(compareVersions('24.12.3.21', '25.12.3.21'), -1)
  })

  it('当第一个较新时（年份）应返回 1', () => {
    assert.equal(compareVersions('25.12.3.21', '24.12.3.21'), 1)
  })

  it('当第一个较旧时（月份）应返回 -1', () => {
    assert.equal(compareVersions('25.11.3.21', '25.12.3.21'), -1)
  })

  it('当第一个较新时（月份）应返回 1', () => {
    assert.equal(compareVersions('25.12.3.21', '25.11.3.21'), 1)
  })

  it('当第一个较旧时（补丁）应返回 -1', () => {
    assert.equal(compareVersions('25.12.2.21', '25.12.3.21'), -1)
  })

  it('当第一个较旧时（构建）应返回 -1', () => {
    assert.equal(compareVersions('25.12.3.20', '25.12.3.21'), -1)
  })

  it('对无效版本应返回 null', () => {
    assert.equal(compareVersions('invalid', '25.12.3.21'), null)
    assert.equal(compareVersions('25.12.3.21', 'invalid'), null)
  })
})

// =============================================================================
// getMajorVersion 测试
// =============================================================================

describe('ClickHouse getMajorVersion', () => {
  it('应从完整版本提取 YY.MM', () => {
    assert.equal(getMajorVersion('25.12.3.21'), '25.12')
  })

  it('应从三部分版本提取 YY.MM', () => {
    assert.equal(getMajorVersion('25.12.3'), '25.12')
  })

  it('对两部分版本应返回原始值', () => {
    assert.equal(getMajorVersion('25.12'), '25.12')
  })

  it('对无效版本应返回原始值', () => {
    assert.equal(getMajorVersion('invalid'), 'invalid')
  })
})

// =============================================================================
// getMajorMinorPatchVersion 测试
// =============================================================================

describe('ClickHouse getMajorMinorPatchVersion', () => {
  it('应从完整版本提取 YY.MM.X', () => {
    assert.equal(getMajorMinorPatchVersion('25.12.3.21'), '25.12.3')
  })

  it('对三部分版本应返回相同值', () => {
    assert.equal(getMajorMinorPatchVersion('25.12.3'), '25.12.3')
  })

  it('对两部分版本应添加 .0', () => {
    assert.equal(getMajorMinorPatchVersion('25.12'), '25.12.0')
  })
})

// =============================================================================
// isVersionSupported 测试
// =============================================================================

describe('ClickHouse isVersionSupported', () => {
  it('应支持 ClickHouse 25.x', () => {
    assert.equal(isVersionSupported('25.12.3.21'), true)
  })

  it('应支持 ClickHouse 24.x', () => {
    assert.equal(isVersionSupported('24.1.0.0'), true)
  })

  it('不应支持 ClickHouse 23.x 或更旧版本', () => {
    assert.equal(isVersionSupported('23.12.0.0'), false)
    assert.equal(isVersionSupported('22.1.0.0'), false)
  })

  it('对无效版本应返回 false', () => {
    assert.equal(isVersionSupported('invalid'), false)
  })
})

// =============================================================================
// isVersionCompatible 测试
// =============================================================================

describe('ClickHouse isVersionCompatible', () => {
  describe('兼容场景', () => {
    it('对相同版本应兼容', () => {
      const result = isVersionCompatible('25.12.3.21', '25.12.3.21')
      assert.equal(result.compatible, true)
      assert.equal(result.warning, undefined)
    })

    it('从旧版本升级时应兼容', () => {
      const result = isVersionCompatible('25.6.0.0', '25.12.0.0')
      assert.equal(result.compatible, true)
      // 可能有关于模式更新的警告
    })

    it('在同一年内差异 6 个月内应兼容', () => {
      const result = isVersionCompatible('25.8.0.0', '25.6.0.0')
      assert.equal(result.compatible, true)
    })

    it('在跨年 6 个月内应兼容', () => {
      // 2026 年 1 月恢复，备份来自 2025 年 11 月（相差 2 个月）
      const result = isVersionCompatible('25.11.0.0', '26.1.0.0')
      assert.equal(result.compatible, true)
    })
  })

  describe('不兼容场景', () => {
    it('当备份比恢复新很多时应不兼容', () => {
      // 新超过 6 个月
      const result = isVersionCompatible('26.6.0.0', '25.6.0.0')
      assert.equal(result.compatible, false)
      assert.ok(result.warning?.includes('much newer'))
    })
  })

  describe('警告场景', () => {
    it('恢复到稍旧版本时应警告', () => {
      const result = isVersionCompatible('25.12.0.0', '25.8.0.0')
      assert.equal(result.compatible, true)
      assert.ok(result.warning?.includes('older'))
    })

    it('跨版本升级时应警告', () => {
      const result = isVersionCompatible('24.12.0.0', '25.12.0.0')
      assert.equal(result.compatible, true)
      // 可能有升级警告
    })
  })

  describe('边缘情况', () => {
    it('当版本无法解析时应兼容', () => {
      const result = isVersionCompatible('invalid', '25.12.0.0')
      assert.equal(result.compatible, true)
      assert.ok(result.warning?.includes('Could not parse'))
    })
  })
})

// =============================================================================
// isValidVersionFormat 测试
// =============================================================================

describe('ClickHouse isValidVersionFormat', () => {
  it('对有效四部分版本应返回 true', () => {
    assert.equal(isValidVersionFormat('25.12.3.21'), true)
  })

  it('对有效两部分版本应返回 true', () => {
    assert.equal(isValidVersionFormat('25.12'), true)
  })

  it('对单个数字应返回 false', () => {
    assert.equal(isValidVersionFormat('25'), false)
  })

  it('对空字符串应返回 false', () => {
    assert.equal(isValidVersionFormat(''), false)
  })
})
