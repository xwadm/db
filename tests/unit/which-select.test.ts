import { describe, it } from 'node:test'
import { selectContainerForWhich } from '../../cli/commands/which'
import { Engine, type ContainerConfig } from '../../types'
import { assert, assertEqual, assertNullish } from '../utils/assertions'

function container(
  overrides: Partial<ContainerConfig> & {
    name: string
    port: number
    status: ContainerConfig['status']
  },
): ContainerConfig {
  return {
    engine: Engine.PostgreSQL,
    version: '17.7.0',
    database: overrides.database ?? overrides.name,
    created: '2026-04-20T00:00:00Z',
    ...overrides,
  }
}

describe('selectContainerForWhich', () => {
  it('应该优先选择运行中的容器而不是同一端口上已停止的容器', () => {
    // 回归问题：`containers.find(c => c.port === target)` 以前返回第一个匹配项，
    // 即使存在运行中的容器，也可能返回已停止的容器。已通过将运行中状态排名高于已停止状态修复。
    const containers = [
      container({ name: 'efficient', port: 5433, status: 'stopped' }),
      container({ name: 'offlabelinsight', port: 5433, status: 'running' }),
    ]
    const match = selectContainerForWhich(containers, { targetPort: 5433 })
    assertEqual(
      match?.name,
      'offlabelinsight',
      '即使运行中的容器不在列表第一位，也应该选择它',
    )
  })

  it('应该优先选择托管目标数据库的运行中容器', () => {
    // 两个运行中的容器共享一个端口 —— 选择实际拥有请求数据库的那个。
    const containers = [
      container({
        name: 'layerbase',
        port: 5433,
        status: 'running',
        database: 'layerbase',
        databases: ['layerbase'],
      }),
      container({
        name: 'offlabelinsight',
        port: 5433,
        status: 'running',
        database: 'offlabelinsight',
        databases: ['offlabelinsight'],
      }),
    ]
    const match = selectContainerForWhich(containers, {
      targetPort: 5433,
      targetDatabase: 'offlabelinsight',
    })
    assertEqual(
      match?.name,
      'offlabelinsight',
      '应该选择托管请求数据库的容器',
    )
  })

  it('应该优先选择运行中且托管数据库的容器，而非仅满足其中一个条件的容器', () => {
    const containers = [
      // 已停止但有该数据库
      container({
        name: 'legacy',
        port: 5433,
        status: 'stopped',
        databases: ['offlabelinsight'],
      }),
      // 运行中但数据库不同
      container({
        name: 'other',
        port: 5433,
        status: 'running',
        databases: ['other'],
      }),
      // 运行中且有该数据库 —— 获胜者
      container({
        name: 'winner',
        port: 5433,
        status: 'running',
        databases: ['offlabelinsight'],
      }),
    ]
    const match = selectContainerForWhich(containers, {
      targetPort: 5433,
      targetDatabase: 'offlabelinsight',
    })
    assertEqual(match?.name, 'winner', '应该优先选择运行中且托管数据库的容器')
  })

  it('当没有区分因素时，应该回退到第一个候选容器', () => {
    const containers = [
      container({ name: 'a', port: 5433, status: 'stopped' }),
      container({ name: 'b', port: 5433, status: 'stopped' }),
    ]
    const match = selectContainerForWhich(containers, { targetPort: 5433 })
    assertEqual(
      match?.name,
      'a',
      '应该是稳定的 —— 平局时第一个候选容器获胜',
    )
  })

  it('当没有容器匹配端口时，应该返回 null', () => {
    const containers = [
      container({ name: 'a', port: 5432, status: 'running' }),
    ]
    const match = selectContainerForWhich(containers, { targetPort: 9999 })
    assertNullish(match, '当没有匹配项时应该返回 null')
  })

  it('应该遵守仅运行中的过滤器', () => {
    const containers = [
      container({ name: 'stopped-one', port: 5433, status: 'stopped' }),
    ]
    const match = selectContainerForWhich(containers, {
      targetPort: 5433,
      runningOnly: true,
    })
    assertNullish(
      match,
      'runningOnly 必须排除已停止的容器，即使它们匹配端口',
    )
  })

  it('应该在排名之前按引擎过滤', () => {
    const containers = [
      container({
        name: 'pg',
        port: 5432,
        status: 'running',
        engine: Engine.PostgreSQL,
      }),
      container({
        name: 'mysql',
        port: 5432,
        status: 'running',
        engine: Engine.MySQL,
      }),
    ]
    const match = selectContainerForWhich(containers, {
      targetPort: 5432,
      targetEngine: Engine.MySQL,
    })
    assertEqual(match?.name, 'mysql', '引擎过滤器应该在排名之前应用')
  })

  it('当目标未定义时，不应该给予数据库奖励分', () => {
    // 边界情况：没有目标数据库时，运行中的容器不应该因为
    // 恰好拥有与请求属性（在此情况下为 undefined）匹配的数据库而获得"提升"。
    const containers = [
      container({
        name: 'a',
        port: 5433,
        status: 'running',
        databases: ['anything'],
      }),
      container({
        name: 'b',
        port: 5433,
        status: 'running',
        databases: ['something'],
      }),
    ]
    const match = selectContainerForWhich(containers, { targetPort: 5433 })
    assertEqual(match?.name, 'a', '分数平局时应该解析为第一个候选容器')
    assert(match !== null, '仍然应该找到运行中的匹配项')
  })
})
