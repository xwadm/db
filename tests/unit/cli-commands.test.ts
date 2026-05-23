import { describe, it } from 'node:test'
import { assert, assertEqual } from '../utils/assertions'

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

// 容器名称验证（与 edit.ts 和 prompts.ts 中的逻辑相同）
function isValidContainerName(name: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)
}

// 版本比较（与 engines.ts 和 menu.ts 中的逻辑相同）
function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map((p) => parseInt(p, 10) || 0)
  const partsB = b.split('.').map((p) => parseInt(p, 10) || 0)

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const numA = partsA[i] || 0
    const numB = partsB[i] || 0
    if (numA !== numB) return numA - numB
  }
  return 0
}

// 字节格式化（与 engines.ts 和 menu.ts 中的逻辑相同）
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
}

describe('容器名称验证', () => {
  describe('有效名称', () => {
    it('应接受简单的字母名称', () => {
      assert(isValidContainerName('mydb'), 'mydb 应为有效')
      assert(isValidContainerName('test'), 'test 应为有效')
      assert(isValidContainerName('PostgreSQL'), 'PostgreSQL 应为有效')
    })

    it('应接受首字符后带数字的名称', () => {
      assert(isValidContainerName('db1'), 'db1 应为有效')
      assert(isValidContainerName('test123'), 'test123 应为有效')
      assert(isValidContainerName('v2db'), 'v2db 应为有效')
    })

    it('应接受带连字符的名称', () => {
      assert(isValidContainerName('my-db'), 'my-db 应为有效')
      assert(
        isValidContainerName('test-container-1'),
        'test-container-1 应为有效',
      )
    })

    it('应接受带下划线的名称', () => {
      assert(isValidContainerName('my_db'), 'my_db 应为有效')
      assert(
        isValidContainerName('test_container_1'),
        'test_container_1 应为有效',
      )
    })

    it('应接受带混合允许字符的名称', () => {
      assert(
        isValidContainerName('my-test_db123'),
        'my-test_db123 应为有效',
      )
      assert(isValidContainerName('A1_b-2'), 'A1_b-2 应为有效')
    })
  })

  describe('无效名称', () => {
    it('应拒绝以数字开头的名称', () => {
      assert(
        !isValidContainerName('1db'),
        '以数字开头的名称应为无效',
      )
      assert(!isValidContainerName('123test'), '123test 应为无效')
    })

    it('应拒绝以特殊字符开头的名称', () => {
      assert(
        !isValidContainerName('-db'),
        '以连字符开头的名称应为无效',
      )
      assert(
        !isValidContainerName('_db'),
        '以下划线开头的名称应为无效',
      )
    })

    it('应拒绝带空格的名称', () => {
      assert(
        !isValidContainerName('my db'),
        '带空格的名称应为无效',
      )
      assert(
        !isValidContainerName('test container'),
        'test container 应为无效',
      )
    })

    it('应拒绝带特殊字符的名称', () => {
      assert(!isValidContainerName('my@db'), '带 @ 的名称应为无效')
      assert(
        !isValidContainerName('test.container'),
        '带句点的名称应为无效',
      )
      assert(!isValidContainerName('db!'), '带 ! 的名称应为无效')
    })

    it('应拒绝空名称', () => {
      assert(!isValidContainerName(''), '空名称应为无效')
    })
  })
})

describe('端口验证', () => {
  describe('有效端口', () => {
    it('应接受标准数据库端口', () => {
      assert(isValidPort(5432), 'PostgreSQL 默认端口应为有效')
      assert(isValidPort(3306), 'MySQL 默认端口应为有效')
    })

    it('应接受最小端口', () => {
      assert(isValidPort(1), '端口 1 应为有效')
    })

    it('应接受最大端口', () => {
      assert(isValidPort(65535), '端口 65535 应为有效')
    })

    it('应接受任意有效端口', () => {
      assert(isValidPort(8080), '端口 8080 应为有效')
      assert(isValidPort(3000), '端口 3000 应为有效')
    })
  })

  describe('无效端口', () => {
    it('应拒绝端口 0', () => {
      assert(!isValidPort(0), '端口 0 应为无效')
    })

    it('应拒绝负端口', () => {
      assert(!isValidPort(-1), '负端口应为无效')
      assert(!isValidPort(-5432), '-5432 应为无效')
    })

    it('应拒绝超过最大值的端口', () => {
      assert(!isValidPort(65536), '端口 65536 应为无效')
      assert(!isValidPort(100000), '端口 100000 应为无效')
    })

    it('应拒绝非整数值', () => {
      assert(!isValidPort(5432.5), '小数端口应为无效')
      assert(!isValidPort(NaN), 'NaN 应为无效')
      assert(!isValidPort(Infinity), 'Infinity 应为无效')
    })
  })
})

describe('版本比较', () => {
  describe('主版本差异', () => {
    it('应正确比较主版本', () => {
      assert(compareVersions('17', '16') > 0, '17 应大于 16')
      assert(compareVersions('15', '16') < 0, '15 应小于 16')
      assert(compareVersions('16', '16') === 0, '16 应等于 16')
    })
  })

  describe('次版本差异', () => {
    it('应正确比较次版本', () => {
      assert(
        compareVersions('16.2', '16.1') > 0,
        '16.2 应大于 16.1',
      )
      assert(
        compareVersions('16.1', '16.2') < 0,
        '16.1 应小于 16.2',
      )
      assert(compareVersions('16.1', '16.1') === 0, '16.1 应等于 16.1')
    })
  })

  describe('补丁版本差异', () => {
    it('应正确比较补丁版本', () => {
      assert(
        compareVersions('16.1.2', '16.1.1') > 0,
        '16.1.2 应大于 16.1.1',
      )
      assert(
        compareVersions('16.1.1', '16.1.2') < 0,
        '16.1.1 应小于 16.1.2',
      )
      assert(
        compareVersions('16.1.1', '16.1.1') === 0,
        '16.1.1 应等于 16.1.1',
      )
    })
  })

  describe('混合版本格式', () => {
    it('应处理不同组件数量的版本', () => {
      assert(
        compareVersions('16.1.0', '16.1') === 0,
        '16.1.0 应等于 16.1',
      )
      assert(compareVersions('16', '16.0') === 0, '16 应等于 16.0')
      assert(compareVersions('16', '16.0.0') === 0, '16 应等于 16.0.0')
    })

    it('应比较不同长度的版本', () => {
      assert(
        compareVersions('16.1', '16.0.5') > 0,
        '16.1 应大于 16.0.5',
      )
      assert(
        compareVersions('16.0.5', '16.1') < 0,
        '16.0.5 应小于 16.1',
      )
    })
  })

  describe('边缘情况', () => {
    it('应正确处理版本 10', () => {
      assert(compareVersions('16', '10') > 0, '16 应大于 10')
      assert(compareVersions('10', '9') > 0, '10 应大于 9')
    })

    it('应处理版本 0 组件', () => {
      assert(compareVersions('16.0', '16') === 0, '16.0 应等于 16')
      assert(
        compareVersions('16.0.1', '16.0') > 0,
        '16.0.1 应大于 16.0',
      )
    })
  })
})

describe('字节格式化', () => {
  describe('字节', () => {
    it('应格式化零字节', () => {
      assertEqual(formatBytes(0), '0 B', '零应格式化为 0 B')
    })

    it('应格式化小字节值', () => {
      assertEqual(
        formatBytes(500),
        '500.0 B',
        '500 字节应正确格式化',
      )
      assertEqual(formatBytes(1), '1.0 B', '1 字节应正确格式化')
    })
  })

  describe('千字节', () => {
    it('应格式化千字节值', () => {
      assertEqual(formatBytes(1024), '1.0 KB', '1024 字节应为 1.0 KB')
      assertEqual(formatBytes(1536), '1.5 KB', '1536 字节应为 1.5 KB')
    })
  })

  describe('兆字节', () => {
    it('应格式化兆字节值', () => {
      assertEqual(
        formatBytes(1024 * 1024),
        '1.0 MB',
        '1 MB 应正确格式化',
      )
      assertEqual(
        formatBytes(45 * 1024 * 1024),
        '45.0 MB',
        '45 MB 应正确格式化',
      )
    })
  })

  describe('吉字节', () => {
    it('应格式化吉字节值', () => {
      assertEqual(
        formatBytes(1024 * 1024 * 1024),
        '1.0 GB',
        '1 GB 应正确格式化',
      )
      assertEqual(
        formatBytes(2.5 * 1024 * 1024 * 1024),
        '2.5 GB',
        '2.5 GB 应正确格式化',
      )
    })
  })
})

describe('连接字符串构建', () => {
  // 测试连接字符串模式
  function buildPostgresConnectionString(
    port: number,
    database: string,
    user = 'postgres',
    host = '127.0.0.1',
  ): string {
    return `postgresql://${user}@${host}:${port}/${database}`
  }

  function buildMysqlConnectionString(
    port: number,
    database: string,
    user = 'root',
    host = '127.0.0.1',
  ): string {
    return `mysql://${user}@${host}:${port}/${database}`
  }

  describe('PostgreSQL 连接字符串', () => {
    it('应构建基本连接字符串', () => {
      const connStr = buildPostgresConnectionString(5432, 'mydb')
      assertEqual(
        connStr,
        'postgresql://postgres@127.0.0.1:5432/mydb',
        '应构建正确的 URL',
      )
    })

    it('应包含自定义端口', () => {
      const connStr = buildPostgresConnectionString(5433, 'testdb')
      assert(connStr.includes(':5433/'), '应包含自定义端口')
    })
  })

  describe('MySQL 连接字符串', () => {
    it('应构建基本连接字符串', () => {
      const connStr = buildMysqlConnectionString(3306, 'mydb')
      assertEqual(
        connStr,
        'mysql://root@127.0.0.1:3306/mydb',
        '应构建正确的 URL',
      )
    })

    it('应包含自定义端口', () => {
      const connStr = buildMysqlConnectionString(3307, 'testdb')
      assert(connStr.includes(':3307/'), '应包含自定义端口')
    })
  })
})
