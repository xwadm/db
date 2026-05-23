/**
 * PostgreSQL binary resolver 测试
 */

import { describe, it } from 'node:test'
import { assert, assertEqual } from '../utils/assertions'
import {
  resolveBinaryPaths,
  getBinaryPath,
} from '../../engines/postgresql/binary-resolver'

describe('PostgreSQL Binary Resolver', () => {
  describe('getBinaryPath', () => {
    it('应构造包含版本和平台的二进制路径', () => {
      const result = getBinaryPath('postgres', '16.0', 'linux', 'x64')

      assert(result.includes('postgres'), '应包含二进制名称')
      assert(result.includes('16.0'), '应包含版本')
      assert(result.includes('linux'), '应包含平台')
      assert(result.includes('x64'), '应包含架构')
    })

    it('应处理不同的二进制文件', () => {
      const binaries = ['postgres', 'psql', 'pg_dump', 'pg_restore', 'pg_ctl']

      for (const binary of binaries) {
        const result = getBinaryPath(binary, '16.0', 'linux', 'x64')
        assert(result.includes(binary), `应包含 ${binary}`)
      }
    })

    it('应处理不同的平台', () => {
      const platforms = ['linux', 'darwin', 'win32']

      for (const platform of platforms) {
        const result = getBinaryPath('postgres', '16.0', platform, 'x64')
        assert(result.includes(platform), `应包含 ${platform}`)
      }
    })

    it('应处理不同的架构', () => {
      const archs = ['x64', 'arm64']

      for (const arch of archs) {
        const result = getBinaryPath('postgres', '16.0', 'linux', arch)
        assert(result.includes(arch), `应包含 ${arch}`)
      }
    })

    it('应为 Windows 添加 .exe 扩展名', () => {
      const result = getBinaryPath('postgres', '16.0', 'win32', 'x64')
      assert(result.includes('.exe'), 'Windows 应包含 .exe')
    })

    it('不应为非 Windows 平台添加 .exe', () => {
      const result = getBinaryPath('postgres', '16.0', 'linux', 'x64')
      assert(!result.includes('.exe'), 'Linux 不应包含 .exe')
    })
  })

  describe('resolveBinaryPaths', () => {
    it('应解析所有必需的 PostgreSQL 二进制文件', async () => {
      const paths = await resolveBinaryPaths('16.0')

      assert(
        paths.postgres !== undefined,
        '应解析 postgres 二进制路径',
      )
      assert(paths.psql !== undefined, '应解析 psql 二进制路径')
      assert(paths.pg_dump !== undefined, '应解析 pg_dump 二进制路径')
      assert(
        paths.pg_restore !== undefined,
        '应解析 pg_restore 二进制路径',
      )
    })

    it('应为不存在的版本返回 undefined', async () => {
      const paths = await resolveBinaryPaths('0.0.0')

      assertEqual(
        paths.postgres,
        undefined,
        '不存在的 postgres 应返回 undefined',
      )
      assertEqual(
        paths.psql,
        undefined,
        '不存在的 psql 应返回 undefined',
      )
    })

    it('应为不存在的 pg_ctl 返回 undefined', async () => {
      const paths = await resolveBinaryPaths('0.0.0')

      assertEqual(
        paths.pg_ctl,
        undefined,
        '不存在的 pg_ctl 应返回 undefined',
      )
    })
  })
})
