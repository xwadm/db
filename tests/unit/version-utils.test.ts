import { describe, it } from 'node:test'
import { isShorthandVersion } from '../../core/version-utils'
import { assert } from '../utils/assertions'

describe('isShorthandVersion', () => {
  describe('纯语义化版本', () => {
    it('1 段版本为简写', () => {
      assert(isShorthandVersion('17') === true, "'17' 应为简写")
      assert(isShorthandVersion('8') === true, "'8' 应为简写")
      assert(isShorthandVersion('0') === true, "'0' 应为简写")
    })

    it('2 段版本为简写', () => {
      assert(isShorthandVersion('8.4') === true, "'8.4' 应为简写")
      assert(isShorthandVersion('11.8') === true, "'11.8' 应为简写")
      assert(isShorthandVersion('25.12') === true, "'25.12' 应为简写")
    })

    it('3 段版本为完整版本', () => {
      assert(isShorthandVersion('17.10.0') === false, "'17.10.0' 应为完整版本")
      assert(isShorthandVersion('11.8.6') === false, "'11.8.6' 应为完整版本")
      assert(isShorthandVersion('8.0.23') === false, "'8.0.23' 应为完整版本")
    })

    it('4 段 ClickHouse 版本为完整版本', () => {
      assert(
        isShorthandVersion('25.12.3.21') === false,
        "'25.12.3.21' 应为完整版本（ClickHouse 4 段）",
      )
    })
  })

  describe('复合版本（postgresql-documentdb）', () => {
    it("复合完整形式不是简写（回归测试：'17-0.107.0'）", () => {
      // 合并前审查中发现的缺陷：之前的实现返回了 true。
      assert(
        isShorthandVersion('17-0.107.0') === false,
        "'17-0.107.0' 应为完整版本——它是固定的复合形式",
      )
    })

    it('仅复合主版本（无后缀）是简写', () => {
      // postgresql-documentdb 的默认配置块将 '17' 映射为 '17-0.107.0'。
      // 单独的容器版本 '17' 是简写，需要迁移。
      assert(
        isShorthandVersion('17') === true,
        "'17' 单独是简写，即使它能解析为复合侧版本",
      )
    })

    it('带有非点分后缀的连字符形式仍是简写', () => {
      // 理论上的预发布类形式。无补丁组件 → 简写。
      assert(
        isShorthandVersion('17-rc1') === true,
        "'17-rc1' 应为简写（无补丁版本）",
      )
    })
  })

  describe('特殊标记及边界情况', () => {
    it('空字符串不是简写', () => {
      assert(isShorthandVersion('') === false, "'' 不应被标记为简写")
    })

    it("'unknown' 不是简写（链接远程容器的标记）", () => {
      assert(
        isShorthandVersion('unknown') === false,
        "'unknown' 不应被标记为简写——调用方会特殊处理它",
      )
    })
  })
})
