import { describe, it } from 'node:test'
import { platform as osPlatform } from 'os'
import { join } from 'path'
import { getLibraryEnv, detectLibraryError } from '../../core/library-env'
import { assert, assertEqual } from '../utils/assertions'

describe('library-env', () => {
  describe('getLibraryEnv', () => {
    const binPath = '/home/user/.spindb/bin/redis-8.4.0-linux-arm64'

    it('应返回具有正确库路径的对象', () => {
      const result = getLibraryEnv(binPath)
      const plat = osPlatform()

      if (plat === 'darwin') {
        assert(result !== undefined, 'macOS 上应返回环境变量')
        assertEqual(
          result!.DYLD_FALLBACK_LIBRARY_PATH,
          join(binPath, 'lib'),
          '应设置 DYLD_FALLBACK_LIBRARY_PATH',
        )
      } else if (plat === 'linux') {
        assert(result !== undefined, 'Linux 上应返回环境变量')
        assertEqual(
          result!.LD_LIBRARY_PATH,
          join(binPath, 'lib'),
          '应设置 LD_LIBRARY_PATH',
        )
      } else if (plat === 'win32') {
        assertEqual(result, undefined, 'Windows 上应返回 undefined')
      }
    })

    it('应指向 binPath 的 lib 子目录', () => {
      const result = getLibraryEnv(binPath)
      const plat = osPlatform()

      if (plat === 'win32') return

      assert(result !== undefined, 'Unix 上应返回环境变量')
      const values = Object.values(result!)
      assert(values.length === 1, '应只有一个环境变量')
      assert(
        values[0].endsWith('/lib'),
        `路径应以 /lib 结尾，实际为：${values[0]}`,
      )
    })
  })

  describe('detectLibraryError', () => {
    it('应检测 macOS dyld 库未加载错误', () => {
      const output =
        'dyld[12345]: Library not loaded: /opt/homebrew/opt/openssl@3/lib/libssl.3.dylib'
      const result = detectLibraryError(output, 'Redis')
      assert(result !== null, '应检测 dyld 错误')
      assert(result!.includes('Redis'), '消息中应包含引擎名称')
    })

    it('macOS SSL 错误应建议 brew install openssl@3', () => {
      const output =
        'dyld: Library not loaded: /opt/homebrew/opt/openssl@3/lib/libssl.3.dylib'
      const result = detectLibraryError(output, 'MariaDB')

      assert(result !== null, '应检测 SSL 库错误')
      if (osPlatform() === 'darwin') {
        assert(
          result!.includes('brew install openssl@3'),
          'macOS 上应建议 brew install',
        )
      }
    })

    it('应检测 libcrypto 加载错误', () => {
      const output =
        'dyld[999]: Library not loaded: /opt/homebrew/opt/openssl@3/lib/libcrypto.3.dylib'
      const result = detectLibraryError(output, 'Valkey')
      assert(result !== null, '应检测 libcrypto 错误')
      assert(result!.includes('Valkey'), '应包含引擎名称')
    })

    it('应检测 GLIBC 版本错误', () => {
      const output =
        '/lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.34` not found'
      const result = detectLibraryError(output, 'Redis')
      assert(result !== null, '应检测 GLIBC 错误')
      assert(result!.includes('GLIBC'), '消息中应提及 GLIBC')
    })

    it('应检测 Linux 共享库错误', () => {
      const output =
        'redis-server: error while loading shared libraries: libssl.so.3: cannot open shared object file: No such file or directory'
      const result = detectLibraryError(output, 'Redis')
      assert(result !== null, '应检测共享库错误')
      assert(
        result!.includes('OpenSSL') || result!.includes('libssl'),
        '消息中应引用 SSL',
      )
    })

    it('应检测通用共享库错误', () => {
      const output =
        'error while loading shared libraries: libfoo.so: cannot open shared object file'
      const result = detectLibraryError(output, 'MariaDB')
      assert(result !== null, '应检测通用共享库错误')
      assert(
        result!.includes('shared library'),
        '应提及 shared library',
      )
    })

    it('非库错误应返回 null', () => {
      const output = 'Address already in use'
      const result = detectLibraryError(output, 'Redis')
      assertEqual(result, null, '端口错误应返回 null')
    })

    it('空输出应返回 null', () => {
      assertEqual(
        detectLibraryError('', 'Redis'),
        null,
        '空字符串应返回 null',
      )
    })

    it('正常启动输出应返回 null', () => {
      const output =
        'Server initialized\nReady to accept connections on port 6379'
      assertEqual(
        detectLibraryError(output, 'Redis'),
        null,
        '正常输出应返回 null',
      )
    })

    it('应检测带括号表示法的 dyld', () => {
      const output = 'dyld[45678]: Library not loaded: @rpath/libssl.3.dylib'
      const result = detectLibraryError(output, 'Valkey')
      assert(result !== null, '应检测 dyld[pid] 格式')
    })

    it('libc.so 引用应作为 GLIBC 错误检测', () => {
      const output = 'error: libc.so.6: cannot handle TLS data'
      const result = detectLibraryError(output, 'MariaDB')
      assert(result !== null, '应检测 libc.so 错误')
      assert(result!.includes('GLIBC'), '消息中应提及 GLIBC')
    })
  })
})
