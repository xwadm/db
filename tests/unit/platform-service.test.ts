import { describe, it, before, after, afterEach } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { paths } from '../../config/paths'
import { platformService } from '../../core/platform-service'
import {
  getBundledBinaryPath,
  findCompatibleVersion,
  detectInstalledPostgres,
} from '../../core/pg-binary-resolver'
import { assert, assertEqual, assertNullish } from '../utils/assertions'

// 保存真实的 paths 方法，以便在测试之间恢复它们。
const realFindInstalledBinaries = paths.findInstalledBinaries.bind(paths)
const realFindInstalledBinaryForMajor =
  paths.findInstalledBinaryForMajor.bind(paths)

type BinaryEntry = { version: string; path: string }

function stubInstalledBinaries(entries: BinaryEntry[]): void {
  paths.findInstalledBinaries = () => entries
  paths.findInstalledBinaryForMajor = (_engine, majorVersion) => {
    const majorPrefix = `${majorVersion}.`
    for (const entry of entries) {
      if (
        entry.version.startsWith(majorPrefix) ||
        entry.version === majorVersion
      ) {
        return entry
      }
    }
    return null
  }
}

function restorePaths(): void {
  paths.findInstalledBinaries = realFindInstalledBinaries
  paths.findInstalledBinaryForMajor = realFindInstalledBinaryForMajor
}

describe('getBundledBinaryPath', () => {
  let tempRoot: string
  let ext: string

  before(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'spindb-bundled-test-'))
    ext = platformService.getExecutableExtension()
  })

  after(async () => {
    try {
      await rm(tempRoot, { recursive: true, force: true })
    } catch {
      // 忽略
    }
  })

  afterEach(() => {
    restorePaths()
  })

  it('当磁盘上存在二进制文件时，返回捆绑工具的路径', async () => {
    const { platform, arch } = platformService.getPlatformInfo()
    const installDir = join(tempRoot, `postgresql-18.1.0-${platform}-${arch}`)
    const binDir = join(installDir, 'bin')
    await mkdir(binDir, { recursive: true })
    await writeFile(join(binDir, `pg_dump${ext}`), 'fake pg_dump')

    stubInstalledBinaries([{ version: '18.1.0', path: installDir }])

    const result = getBundledBinaryPath('pg_dump', '18')
    assertEqual(
      result,
      join(binDir, `pg_dump${ext}`),
      '应返回捆绑的 pg_dump 路径',
    )
  })

  it('当没有与请求的主版本匹配的捆绑安装时，返回 null', () => {
    stubInstalledBinaries([
      { version: '17.7.0', path: '/nonexistent/postgresql-17' },
    ])

    const result = getBundledBinaryPath('pg_dump', '18')
    assertNullish(result, '当没有安装匹配的主版本时，应返回 null')
  })

  it('当安装目录存在但工具二进制文件缺失时，返回 null', async () => {
    const { platform, arch } = platformService.getPlatformInfo()
    const installDir = join(
      tempRoot,
      `postgresql-missing-19.0.0-${platform}-${arch}`,
    )
    await mkdir(join(installDir, 'bin'), { recursive: true })

    stubInstalledBinaries([{ version: '19.0.0', path: installDir }])

    const result = getBundledBinaryPath('pg_restore', '19')
    assertNullish(result, '当特定的工具二进制文件缺失时，应返回 null')
  })

  it('当最新的安装缺少工具时，回退到较旧的同主版本安装', async () => {
    const { platform, arch } = platformService.getPlatformInfo()

    // 模拟一个部分损坏的 pg 18.2 安装——bin 目录存在但 pg_dump 从未解压。
    const broken = join(tempRoot, `postgresql-18.2.0-${platform}-${arch}`)
    await mkdir(join(broken, 'bin'), { recursive: true })

    // 一个健康的旧 pg 18.1 安装，包含 pg_dump。
    const healthy = join(tempRoot, `postgresql-18.1.0-${platform}-${arch}`)
    const healthyBinDir = join(healthy, 'bin')
    await mkdir(healthyBinDir, { recursive: true })
    await writeFile(join(healthyBinDir, `pg_dump${ext}`), 'fake pg_dump')

    // findInstalledBinaries 按最新优先排序，因此损坏的安装排在前面。
    stubInstalledBinaries([
      { version: '18.2.0', path: broken },
      { version: '18.1.0', path: healthy },
    ])

    const result = getBundledBinaryPath('pg_dump', '18')
    assertEqual(
      result,
      join(healthyBinDir, `pg_dump${ext}`),
      '应跳过损坏的安装并返回健康的安装',
    )
  })
})

describe('findCompatibleVersion', () => {
  let tempRoot: string
  let ext: string

  before(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'spindb-compat-test-'))
    ext = platformService.getExecutableExtension()
  })

  after(async () => {
    try {
      await rm(tempRoot, { recursive: true, force: true })
    } catch {
      // 忽略
    }
  })

  afterEach(() => {
    restorePaths()
  })

  async function createBundledInstall(version: string): Promise<BinaryEntry> {
    const { platform, arch } = platformService.getPlatformInfo()
    const installDir = join(
      tempRoot,
      `postgresql-${version}-${platform}-${arch}`,
    )
    const binDir = join(installDir, 'bin')
    await mkdir(binDir, { recursive: true })
    await writeFile(join(binDir, `pg_dump${ext}`), 'fake pg_dump')
    return { version, path: installDir }
  }

  it('为远程服务器选择最低的兼容捆绑版本', async () => {
    const pg17 = await createBundledInstall('17.7.0')
    const pg18 = await createBundledInstall('18.1.0')
    const pg19 = await createBundledInstall('19.0.0')

    stubInstalledBinaries([pg19, pg18, pg17])

    const result = findCompatibleVersion(18)
    assertEqual(
      result?.majorVersion,
      '18',
      '应选择 pg18（最低主版本 >= 18）来读取 pg18 远程',
    )
  })

  it('当没有捆绑版本比远程新时，返回 null', async () => {
    const pg17 = await createBundledInstall('17.7.0')
    stubInstalledBinaries([pg17])

    const result = findCompatibleVersion(18)
    assertNullish(result, '当最新的捆绑主版本比远程旧时，应返回 null')
  })

  it('绝不检查通过 Homebrew 或 APT 安装的 PostgreSQL', () => {
    // 当没有注册的捆绑二进制文件时，解析器必须返回空，
    // 无论 /opt/homebrew 或 /usr/lib/postgresql 中包含什么。
    stubInstalledBinaries([])
    const result = findCompatibleVersion(14)
    assertNullish(result, '解析器不得回退到系统安装的 PostgreSQL')

    const all = detectInstalledPostgres()
    assertEqual(
      all.length,
      0,
      'detectInstalledPostgres 必须仅列出捆绑的二进制文件',
    )
  })
})

describe('无系统安装补救提示', () => {
  it('PostgreSQL 代码路径绝不建议对 PostgreSQL 使用 brew install 或 apt install', async () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const repoRoot = resolve(here, '..', '..')

    const filesToCheck = [
      'core/pg-binary-resolver.ts',
      'engines/postgresql/version-validator.ts',
      'engines/postgresql/index.ts',
      'engines/postgresql/restore.ts',
      'engines/postgresql/backup.ts',
    ]

    for (const rel of filesToCheck) {
      const source = await readFile(join(repoRoot, rel), 'utf8')
      assert(
        !/brew install postgresql/.test(source),
        `${rel} 不得告知用户使用 \`brew install postgresql\`——应使用 \`spindb engines download postgresql\``,
      )
      assert(
        !/apt install postgresql-client/.test(source),
        `${rel} 不得告知用户使用 \`apt install postgresql-client\`——应使用 \`spindb engines download postgresql\``,
      )
    }
  })
})
