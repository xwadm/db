import { describe, it } from 'node:test'
import {
  isVersionEnabled,
  isVersionDeprecated,
  unwrapDatabasesJson,
} from '../../core/hostdb-metadata'
import { assertEqual } from '../utils/assertions'

describe('isVersionEnabled', () => {
  it('对于布尔值 true 应返回 true', () => {
    assertEqual(isVersionEnabled(true), true, 'true 应为 enabled')
  })

  it('对于布尔值 false 应返回 false', () => {
    assertEqual(isVersionEnabled(false), false, 'false 应为 disabled')
  })

  it('对于空对象应返回 true（默认 enabled）', () => {
    assertEqual(isVersionEnabled({}), true, '空对象应为 enabled')
  })

  it('对于包含 enabled: true 的对象应返回 true', () => {
    assertEqual(
      isVersionEnabled({ enabled: true }),
      true,
      '显式 enabled 应为 true',
    )
  })

  it('对于包含 enabled: false 的对象应返回 false', () => {
    assertEqual(
      isVersionEnabled({ enabled: false }),
      false,
      '显式 disabled 应为 false',
    )
  })

  it('对于仅包含 platforms 的对象应返回 true', () => {
    assertEqual(
      isVersionEnabled({ platforms: ['darwin-arm64'] }),
      true,
      '包含 platforms 但无 enabled 字段的对象应为 enabled',
    )
  })

  it('对于包含 dependencies 的对象应返回 true', () => {
    assertEqual(
      isVersionEnabled({
        dependencies: [
          { database: 'postgresql', cascadeDelete: true, note: 'required' },
        ],
      }),
      true,
      '包含 dependencies 但无 enabled 字段的对象应为 enabled',
    )
  })

  it('对于 deprecated 版本应返回 true（仍然 enabled）', () => {
    assertEqual(
      isVersionEnabled({ deprecated: true }),
      true,
      'deprecated 版本仍应为 enabled',
    )
  })
})

describe('isVersionDeprecated', () => {
  it('对于布尔值 true 应返回 false', () => {
    assertEqual(
      isVersionDeprecated(true),
      false,
      '布尔值 true 不是 deprecated',
    )
  })

  it('对于布尔值 false 应返回 false', () => {
    assertEqual(
      isVersionDeprecated(false),
      false,
      '布尔值 false 不是 deprecated',
    )
  })

  it('对于空对象应返回 false', () => {
    assertEqual(
      isVersionDeprecated({}),
      false,
      '空对象不是 deprecated',
    )
  })

  it('对于包含 deprecated: true 的对象应返回 true', () => {
    assertEqual(
      isVersionDeprecated({ deprecated: true }),
      true,
      '显式 deprecated 应为 true',
    )
  })

  it('对于包含 deprecated: false 的对象应返回 false', () => {
    assertEqual(
      isVersionDeprecated({ deprecated: false }),
      false,
      '显式非 deprecated 应为 false',
    )
  })

  it('对于带 note 的 deprecated 版本应返回 true', () => {
    assertEqual(
      isVersionDeprecated({ deprecated: true, note: 'Use 9.6.0 instead' }),
      true,
      '带 note 的 deprecated 应为 true',
    )
  })

  it('对于仅包含 platforms 的对象应返回 false', () => {
    assertEqual(
      isVersionDeprecated({ platforms: ['linux-x64'] }),
      false,
      '仅包含 platforms 的对象不是 deprecated',
    )
  })
})

describe('unwrapDatabasesJson', () => {
  it('应解包带有 databases 包装器的当前 schema', () => {
    const raw = {
      _generated: '2026-03-11',
      $schema: 'https://example.com/schema.json',
      databases: {
        mysql: { displayName: 'MySQL', versions: { '9.6.0': true } },
        postgresql: { displayName: 'PostgreSQL', versions: { '17.7.0': true } },
      },
    }
    const result = unwrapDatabasesJson(raw)
    assertEqual('mysql' in result, true, '应有 mysql 键')
    assertEqual('postgresql' in result, true, '应有 postgresql 键')
    assertEqual('_generated' in result, false, '不应有元数据键')
    assertEqual(
      'databases' in result,
      false,
      '不应有 databases 包装器',
    )
  })

  it('应透传旧版扁平 schema', () => {
    const raw = {
      mysql: { displayName: 'MySQL', versions: { '9.6.0': true } },
      postgresql: { displayName: 'PostgreSQL', versions: { '17.7.0': true } },
    }
    const result = unwrapDatabasesJson(raw)
    assertEqual('mysql' in result, true, '应有 mysql 键')
    assertEqual('postgresql' in result, true, '应有 postgresql 键')
  })

  it('若 databases 为数组则不应解包', () => {
    const raw = {
      databases: ['mysql', 'postgresql'],
      mysql: { displayName: 'MySQL', versions: {} },
    }
    const result = unwrapDatabasesJson(raw)
    assertEqual('mysql' in result, true, '应视为扁平 schema')
    assertEqual(
      'databases' in result,
      true,
      '应保留 databases 数组原样',
    )
  })
})
