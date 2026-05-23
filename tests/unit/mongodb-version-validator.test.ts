import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseVersion,
  compareVersions,
  isVersionCompatible,
  getMajorMinorVersion,
  isValidVersionFormat,
} from '../../engines/mongodb/version-validator'

// =============================================================================
// parseVersion 测试
// =============================================================================

describe('MongoDB parseVersion', () => {
  describe('标准版本字符串', () => {
    it('应解析完整的三段式版本', () => {
      const result = parseVersion('8.0.4')
      assert.notEqual(result, null)
      assert.equal(result?.major, 8)
      assert.equal(result?.minor, 0)
      assert.equal(result?.patch, 4)
      assert.equal(result?.raw, '8.0.4')
    })

    it('应解析两段式版本', () => {
      const result = parseVersion('8.0')
      assert.notEqual(result, null)
      assert.equal(result?.major, 8)
      assert.equal(result?.minor, 0)
      assert.equal(result?.patch, 0)
    })

    it('应解析 MongoDB 7.x 版本', () => {
      const result = parseVersion('7.0.12')
      assert.notEqual(result, null)
      assert.equal(result?.major, 7)
      assert.equal(result?.minor, 0)
      assert.equal(result?.patch, 12)
    })
  })

  describe('带前缀的版本', () => {
    it('应处理带小写 "v" 前缀的版本', () => {
      const result = parseVersion('v8.0.4')
      assert.notEqual(result, null)
      assert.equal(result?.major, 8)
      assert.equal(result?.minor, 0)
    })

    it('应处理带空白的版本', () => {
      const result = parseVersion('  8.0.4  ')
      assert.notEqual(result, null)
      assert.equal(result?.major, 8)
      assert.equal(result?.minor, 0)
    })
  })

  describe('错误处理', () => {
    it('应返回 null 当输入为单个数字', () => {
      const result = parseVersion('8')
      assert.equal(result, null)
    })

    it('应返回 null 当输入为空字符串', () => {
      const result = parseVersion('')
      assert.equal(result, null)
    })

    it('应返回 null 当输入为非数字版本', () => {
      const result = parseVersion('abc.def')
      assert.equal(result, null)
    })
  })
})

// =============================================================================
// compareVersions 测试
// =============================================================================

describe('MongoDB compareVersions', () => {
  it('应返回 0 当版本相等', () => {
    assert.equal(compareVersions('8.0.4', '8.0.4'), 0)
  })

  it('应返回 -1 当第一个版本较旧（major 不同）', () => {
    assert.equal(compareVersions('7.0.0', '8.0.0'), -1)
  })

  it('应返回 1 当第一个版本较新（major 不同）', () => {
    assert.equal(compareVersions('8.0.0', '7.0.0'), 1)
  })

  it('应返回 -1 当第一个版本较旧（minor 不同）', () => {
    assert.equal(compareVersions('8.0.0', '8.1.0'), -1)
  })

  it('应返回 1 当第一个版本较新（minor 不同）', () => {
    assert.equal(compareVersions('8.2.0', '8.1.0'), 1)
  })

  it('应返回 -1 当第一个版本较旧（patch 不同）', () => {
    assert.equal(compareVersions('8.0.3', '8.0.4'), -1)
  })

  it('应返回 1 当第一个版本较新（patch 不同）', () => {
    assert.equal(compareVersions('8.0.4', '8.0.3'), 1)
  })

  it('应返回 null 当版本无效', () => {
    assert.equal(compareVersions('invalid', '8.0.4'), null)
    assert.equal(compareVersions('8.0.4', 'invalid'), null)
  })
})

// =============================================================================
// isVersionCompatible 测试
// =============================================================================

describe('MongoDB isVersionCompatible', () => {
  describe('兼容场景', () => {
    it('应为兼容当版本相同', () => {
      const result = isVersionCompatible('8.0.4', '8.0.4')
      assert.equal(result.compatible, true)
      assert.equal(result.warning, undefined)
    })

    it('应为兼容当 major 版本相同', () => {
      const result = isVersionCompatible('8.0.2', '8.0.4')
      assert.equal(result.compatible, true)
      assert.equal(result.warning, undefined)
    })

    it('应为兼容当升级一个 major 版本', () => {
      const result = isVersionCompatible('7.0.12', '8.0.4')
      assert.equal(result.compatible, true)
      assert.ok(result.warning?.includes('upgrade'))
    })
  })

  describe('不兼容场景', () => {
    it('应为不兼容当将新版本恢复到旧 major 版本', () => {
      const result = isVersionCompatible('8.0.4', '7.0.12')
      assert.equal(result.compatible, false)
      assert.ok(result.warning?.includes('newer major'))
    })

    it('应为不兼容当 major 版本差异超过一个', () => {
      const result = isVersionCompatible('6.0.0', '8.0.4')
      assert.equal(result.compatible, false)
      assert.ok(result.warning?.includes('too large'))
    })
  })

  describe('边界情况', () => {
    it('应为兼容当版本无法解析', () => {
      const result = isVersionCompatible('invalid', '8.0.4')
      assert.equal(result.compatible, true)
      assert.ok(result.warning?.includes('Could not parse'))
    })
  })
})

// =============================================================================
// getMajorMinorVersion 测试
// =============================================================================

describe('MongoDB getMajorMinorVersion', () => {
  it('应从完整版本中提取 major.minor', () => {
    assert.equal(getMajorMinorVersion('8.0.4'), '8.0')
  })

  it('应处理两段式版本', () => {
    assert.equal(getMajorMinorVersion('8.0'), '8.0')
  })

  it('应返回原始值当版本无效', () => {
    assert.equal(getMajorMinorVersion('invalid'), 'invalid')
  })
})

// =============================================================================
// isValidVersionFormat 测试
// =============================================================================

describe('MongoDB isValidVersionFormat', () => {
  it('应返回 true 当为有效的三段式版本', () => {
    assert.equal(isValidVersionFormat('8.0.4'), true)
  })

  it('应返回 true 当为有效的两段式版本', () => {
    assert.equal(isValidVersionFormat('8.0'), true)
  })

  it('应返回 false 当为单个数字', () => {
    assert.equal(isValidVersionFormat('8'), false)
  })

  it('应返回 false 当为空字符串', () => {
    assert.equal(isValidVersionFormat(''), false)
  })
})
