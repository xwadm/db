/**
 * 版本工具函数单元测试
 */

import { describe, it } from 'node:test'
import { assert, assertEqual } from '../utils/assertions'
import { isShorthandVersion } from '../../core/version-utils'

describe('版本工具', () => {
  describe('isShorthandVersion', () => {
    it('应该识别主版本简写', () => {
      assert(isShorthandVersion('17'), '17 应该是简写版本')
      assert(isShorthandVersion('16'), '16 应该是简写版本')
      assert(isShorthandVersion('8'), '8 应该是简写版本')
    })

    it('应该识别主版本.次版本简写', () => {
      assert(isShorthandVersion('17.7'), '17.7 应该是简写版本')
      assert(isShorthandVersion('16.4'), '16.4 应该是简写版本')
      assert(isShorthandVersion('8.0'), '8.0 应该是简写版本')
    })

    it('不应该将完整版本识别为简写', () => {
      assert(!isShorthandVersion('17.7.0'), '17.7.0 不应该是简写版本')
      assert(!isShorthandVersion('16.4.2'), '16.4.2 不应该是简写版本')
      assert(!isShorthandVersion('8.0.33'), '8.0.33 不应该是简写版本')
    })

    it('不应该将无效字符串识别为简写', () => {
      assert(!isShorthandVersion(''), '空字符串不应该是简写版本')
      assert(!isShorthandVersion('latest'), 'latest 不应该是简写版本')
      assert(!isShorthandVersion('invalid'), 'invalid 不应该是简写版本')
    })

    it('应该处理带 v 前缀的版本', () => {
      assert(isShorthandVersion('v17'), 'v17 应该是简写版本')
      assert(isShorthandVersion('v17.7'), 'v17.7 应该是简写版本')
      assert(!isShorthandVersion('v17.7.0'), 'v17.7.0 不应该是简写版本')
    })

    it('应该处理前导零', () => {
      assert(isShorthandVersion('07'), '07 应该是简写版本')
      assert(isShorthandVersion('07.2'), '07.2 应该是简写版本')
    })
  })
})
