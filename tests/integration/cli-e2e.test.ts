/**
 * CLI 端到端测试
 *
 * 测试实际的 CLI 命令（spindb create、list、info 等），
 * 而非直接调用核心模块。
 */

import { describe, it, before, after } from 'node:test'
import { exec } from 'child_process'
import { promisify } from 'util'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync } from 'fs'
import { rm, mkdir } from 'fs/promises'

import {
  generateTestName,
  cleanupTestContainers,
  findConsecutiveFreePorts,
  TEST_PORTS,
  waitForReady,
} from './helpers'
import { assert, assertEqual } from '../utils/assertions'
import { Engine } from '../../types'

const __dirname = dirname(fileURLToPath(import.meta.url))
const execAsync = promisify(exec)

// Windows CI 对某些操作来说过慢
const IS_WINDOWS = process.platform === 'win32'

// 直接使用 tsx 运行 CLI，避免 pnpm 输出污染
const CLI_PATH = join(__dirname, '../../cli/bin.ts')

// 运行 CLI 命令并返回 stdout/stderr
async function runCLI(
  args: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execAsync(
      `node --import tsx "${CLI_PATH}" ${args}`,
      {
        cwd: join(__dirname, '../..'),
        timeout: 60000,
      },
    )
    return { stdout, stderr, exitCode: 0 }
  } catch (error) {
    const execError = error as {
      stdout?: string
      stderr?: string
      code?: number
    }
    return {
      stdout: execError.stdout || '',
      stderr: execError.stderr || '',
      exitCode: execError.code || 1,
    }
  }
}

describe('CLI 端到端测试', () => {
  describe('版本与帮助命令', () => {
    it('应显示版本信息', async () => {
      const { stdout, exitCode } = await runCLI('--version')
      assert(exitCode === 0, '版本命令应成功执行')
      assert(stdout.includes('.'), '版本号应包含点号（语义化版本）')
      console.log(`   版本：${stdout.trim()}`)
    })

    it('应显示帮助信息', async () => {
      const { stdout, exitCode } = await runCLI('--help')
      assert(exitCode === 0, '帮助命令应成功执行')
      assert(stdout.includes('create'), '帮助信息应提及 create 命令')
      assert(stdout.includes('list'), '帮助信息应提及 list 命令')
      assert(stdout.includes('start'), '帮助信息应提及 start 命令')
      console.log('   帮助输出包含预期命令')
    })
  })

  describe('Doctor 命令', () => {
    it(
      '应运行健康检查',
      { skip: IS_WINDOWS ? 'Doctor 命令在 Windows CI 上过慢' : false },
      async () => {
        const { stdout, exitCode } = await runCLI('doctor')
        // 如果缺少依赖项，doctor 可能以退出码 1 结束，但应该能运行
        assert(exitCode === 0 || exitCode === 1, 'Doctor 命令应正常完成')
        assert(
          stdout.includes('Configuration') ||
            stdout.includes('Health Check') ||
            stdout.includes('Containers'),
          'Doctor 应显示健康检查信息',
        )
        console.log('   健康检查已完成')
      },
    )
  })

  describe('引擎命令', () => {
    it('应列出可用引擎', async () => {
      const { stdout, exitCode } = await runCLI('engines list')
      assert(exitCode === 0, '引擎列表命令应成功执行')
      // 注意：引擎列表仅显示已安装的引擎
      // CI 中会下载 PostgreSQL，所有平台都预装了 SQLite
      // MySQL 可能安装也可能未安装，取决于具体的 CI 任务
      assert(
        stdout.toLowerCase().includes('postgresql') ||
          stdout.toLowerCase().includes('postgres'),
        '应列出 PostgreSQL（CI 中已下载）',
      )
      assert(
        stdout.toLowerCase().includes('sqlite'),
        '应列出 SQLite（所有平台预装）',
      )
      // MySQL 是可选的——仅在已安装时才检查
      const hasMysql = stdout.toLowerCase().includes('mysql')
      console.log(
        `   已列出引擎：PostgreSQL、SQLite${hasMysql ? '、MySQL' : ''}`,
      )
    })
  })

  describe('List 命令（空状态）', () => {
    before(async () => {
      // 清理所有现有的测试容器
      await cleanupTestContainers()
    })

    it('应列出容器（可能为空）', async () => {
      const { exitCode } = await runCLI('list')
      assert(exitCode === 0, 'List 命令应成功执行')
      // 输出可能为空，也可能显示已有容器
      console.log('   List 命令成功执行')
    })

    it('应以 JSON 格式列出容器', async () => {
      const { stdout, exitCode } = await runCLI('list --json')
      assert(exitCode === 0, 'List --json 应成功执行')
      // 应为有效的 JSON（数组）
      const parsed = JSON.parse(stdout)
      assert(Array.isArray(parsed), 'JSON 输出应为数组')
      console.log(`   JSON 列表包含 ${parsed.length} 个容器`)
    })
  })
})

describe('CLI PostgreSQL 工作流', () => {
  let containerName: string
  let testPort: number

  before(async () => {
    console.log('\n 正在清理测试容器...')
    await cleanupTestContainers()

    const ports = await findConsecutiveFreePorts(1, TEST_PORTS.postgresql.base)
    testPort = ports[0]
    containerName = generateTestName('clipg')
    console.log(`   使用容器：${containerName}，端口：${testPort}`)
  })

  after(async () => {
    console.log('\n 最终清理...')
    await cleanupTestContainers()
  })

  it('应通过 CLI 创建 PostgreSQL 容器', async () => {
    console.log(`\n 正在创建容器 "${containerName}"...`)

    // 注意：不要使用 --version 标志，因为它与全局的 -v/--version 冲突
    // 引擎将使用默认/最新版本
    const { stdout, stderr, exitCode } = await runCLI(
      `create ${containerName} --engine postgresql --port ${testPort} --no-start`,
    )

    assert(exitCode === 0, `创建应成功。stderr: ${stderr}, stdout: ${stdout}`)
    console.log('   容器已创建')
  })

  it('应在列表中显示容器', async () => {
    const { stdout, exitCode } = await runCLI('list --json')
    assert(exitCode === 0, 'List 应成功执行')

    const containers = JSON.parse(stdout)
    const found = containers.find(
      (c: { name: string }) => c.name === containerName,
    )
    assert(found, `容器 "${containerName}" 应在列表中`)
    assertEqual(found.engine, 'postgresql', '引擎应为 postgresql')
    console.log('   容器出现在列表中')
  })

  it('应通过 CLI 启动容器', async () => {
    console.log(`\n 正在启动容器 "${containerName}"...`)

    const { exitCode, stderr } = await runCLI(`start ${containerName}`)
    assert(exitCode === 0, `启动应成功。stderr: ${stderr}`)

    // 等待 PostgreSQL 就绪
    const ready = await waitForReady(Engine.PostgreSQL, testPort)
    assert(ready, 'PostgreSQL 应已就绪')
    console.log('   容器已启动并就绪')
  })

  it('应通过 CLI 显示容器信息', async () => {
    const { stdout, exitCode } = await runCLI(`info ${containerName}`)
    assert(exitCode === 0, 'Info 应成功执行')
    assert(stdout.includes(containerName), 'Info 应显示容器名称')
    assert(
      stdout.includes('running') || stdout.includes('Running'),
      'Info 应显示运行中状态',
    )
    console.log('   Info 命令显示了容器详情')
  })

  it('应通过 CLI 显示连接 URL', async () => {
    const { stdout, exitCode } = await runCLI(`url ${containerName}`)
    assert(exitCode === 0, 'URL 命令应成功执行')
    assert(stdout.includes('postgresql://'), 'URL 应为 PostgreSQL 格式')
    assert(stdout.includes(String(testPort)), 'URL 应包含端口号')
    console.log(`   URL: ${stdout.trim()}`)
  })

  it('应通过 CLI 运行 SQL', async () => {
    const { exitCode, stderr } = await runCLI(
      `run ${containerName} --sql "SELECT 1 as test"`,
    )
    assert(exitCode === 0, `运行 SQL 应成功。stderr: ${stderr}`)
    console.log('   SQL 已成功执行')
  })

  it('应通过 CLI 停止容器', async () => {
    console.log(`\n 正在停止容器 "${containerName}"...`)

    const { exitCode, stderr } = await runCLI(`stop ${containerName}`)
    assert(exitCode === 0, `停止应成功。stderr: ${stderr}`)
    console.log('   容器已停止')
  })

  it('应在 info 中显示已停止状态', async () => {
    const { stdout, exitCode } = await runCLI(`info ${containerName}`)
    assert(exitCode === 0, 'Info 应成功执行')
    assert(
      stdout.includes('stopped') || stdout.includes('Stopped'),
      'Info 应显示已停止状态',
    )
    console.log('   Info 显示已停止状态')
  })

  it('应通过 CLI 删除容器', async () => {
    console.log(`\n 正在删除容器 "${containerName}"...`)

    const { exitCode, stderr } = await runCLI(
      `delete ${containerName} --force --yes`,
    )
    assert(exitCode === 0, `删除应成功。stderr: ${stderr}`)
    console.log('   容器已删除')
  })

  it('不应在列表中显示已删除的容器', async () => {
    const { stdout, exitCode } = await runCLI('list --json')
    assert(exitCode === 0, 'List 应成功执行')

    const containers = JSON.parse(stdout)
    const found = containers.find(
      (c: { name: string }) => c.name === containerName,
    )
    assert(!found, '已删除的容器不应在列表中')
    console.log('   容器不再出现在列表中')
  })
})

describe('CLI SQLite 工作流', () => {
  let containerName: string
  let dbPath: string
  const testDir = join(__dirname, '../.test-cli-sqlite')

  before(async () => {
    console.log('\n 正在清理测试容器...')
    await cleanupTestContainers()
    await mkdir(testDir, { recursive: true })

    containerName = generateTestName('clisqlite')
    dbPath = join(testDir, `${containerName}.sqlite`)
    console.log(`   使用容器：${containerName}`)
  })

  after(async () => {
    console.log('\n 最终清理...')
    await cleanupTestContainers()
    if (existsSync(testDir)) {
      await rm(testDir, { recursive: true, force: true })
    }
  })

  it('应通过 CLI 创建 SQLite 数据库', async () => {
    console.log(`\n 正在创建 SQLite 数据库 "${containerName}"...`)

    const { exitCode, stderr, stdout } = await runCLI(
      `create ${containerName} --engine sqlite --path "${dbPath}"`,
    )

    assert(exitCode === 0, `创建应成功。stderr: ${stderr}, stdout: ${stdout}`)
    assert(existsSync(dbPath), '数据库文件应存在')
    console.log('   SQLite 数据库已创建')
  })

  it('应在列表中显示 SQLite 容器', async () => {
    const { stdout, exitCode } = await runCLI('list --json')
    assert(exitCode === 0, 'List 应成功执行')

    const containers = JSON.parse(stdout)
    const found = containers.find(
      (c: { name: string }) => c.name === containerName,
    )
    assert(found, `容器 "${containerName}" 应在列表中`)
    assertEqual(found.engine, 'sqlite', '引擎应为 sqlite')
    console.log('   SQLite 容器出现在列表中')
  })

  it('应通过 CLI 显示 SQLite 信息', async () => {
    const { stdout, exitCode } = await runCLI(`info ${containerName}`)
    assert(exitCode === 0, 'Info 应成功执行')
    assert(stdout.includes(containerName), 'Info 应显示容器名称')
    console.log('   Info 命令显示了 SQLite 详情')
  })

  it('应通过 CLI 在 SQLite 上运行 SQL', async () => {
    // 创建表
    const { exitCode: createExit } = await runCLI(
      `run ${containerName} --sql "CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)"`,
    )
    assert(createExit === 0, '创建表应成功')

    // 插入数据
    const { exitCode: insertExit } = await runCLI(
      `run ${containerName} --sql "INSERT INTO test (name) VALUES ('hello')"`,
    )
    assert(insertExit === 0, '插入应成功')

    console.log('   SQL 操作已在 SQLite 上完成')
  })

  it('应通过 CLI 删除 SQLite 容器', async () => {
    console.log(`\n 正在删除 SQLite 容器 "${containerName}"...`)

    const { exitCode, stderr } = await runCLI(
      `delete ${containerName} --force --yes`,
    )
    assert(exitCode === 0, `删除应成功。stderr: ${stderr}`)
    assert(!existsSync(dbPath), '数据库文件应已删除')
    console.log('   SQLite 容器和文件已删除')
  })
})

describe('CLI URL 命令', () => {
  let containerName: string
  let testPort: number

  before(async () => {
    console.log('\n 正在清理测试容器...')
    await cleanupTestContainers()

    const ports = await findConsecutiveFreePorts(1, TEST_PORTS.postgresql.base)
    testPort = ports[0]
    containerName = generateTestName('cliurl')
    console.log(`   使用容器：${containerName}，端口：${testPort}`)
  })

  after(async () => {
    console.log('\n 最终清理...')
    await cleanupTestContainers()
  })

  it('应为 URL 测试创建并启动容器', async () => {
    const { exitCode, stderr, stdout } = await runCLI(
      `create ${containerName} --engine postgresql --port ${testPort} --start`,
    )
    assert(exitCode === 0, `创建应成功。stderr: ${stderr}, stdout: ${stdout}`)

    const ready = await waitForReady(Engine.PostgreSQL, testPort)
    assert(ready, 'PostgreSQL 应已就绪')
    console.log('   容器已创建并启动')
  })

  it('应显示连接 URL', async () => {
    const { stdout, exitCode } = await runCLI(`url ${containerName}`)
    assert(exitCode === 0, 'URL 命令应成功执行')
    assert(stdout.includes('postgresql://'), 'URL 应为 PostgreSQL 格式')
    assert(stdout.includes(String(testPort)), 'URL 应包含端口号')
    console.log(`   URL: ${stdout.trim()}`)
  })

  it('应以 JSON 格式显示 URL', async () => {
    const { stdout, stderr, exitCode } = await runCLI(
      `url ${containerName} --json`,
    )
    assert(
      exitCode === 0,
      `URL --json 应成功。stdout: ${stdout}, stderr: ${stderr}`,
    )

    const parsed = JSON.parse(stdout)
    assert(
      parsed.connectionString !== undefined,
      `JSON 应包含 connectionString 字段。实际键名：${Object.keys(parsed).join(', ')}`,
    )
    assert(
      parsed.connectionString.includes('postgresql://'),
      `连接字符串应为 PostgreSQL 格式。实际值：${parsed.connectionString}`,
    )
    console.log('   JSON URL 输出已验证')
  })

  it('应清理 URL 测试容器', async () => {
    const { exitCode: stopExit } = await runCLI(`stop ${containerName}`)
    assert(stopExit === 0, '停止应成功')

    const { exitCode: deleteExit } = await runCLI(
      `delete ${containerName} --force --yes`,
    )
    assert(deleteExit === 0, '删除应成功')
    console.log('   容器已清理')
  })
})

describe('CLI 连接字符串推断', () => {
  let containerName: string
  let testPort: number

  before(async () => {
    console.log('\n 正在清理测试容器...')
    await cleanupTestContainers()

    const ports = await findConsecutiveFreePorts(1, TEST_PORTS.postgresql.base)
    testPort = ports[0]
    containerName = generateTestName('clifrom')
    console.log(`   使用容器：${containerName}，端口：${testPort}`)
  })

  after(async () => {
    console.log('\n 最终清理...')
    await cleanupTestContainers()
  })

  it('应通过连接字符串推断引擎来创建容器', async () => {
    // 使用 --from 从 PostgreSQL 连接字符串推断引擎
    // 注意：这会创建一个容器并尝试从连接中拉取架构
    // 为测试起见，我们使用一个实际不会连接的 localhost 连接，
    // 但仍应正确推断引擎类型
    const connectionString = `postgresql://user:pass@127.0.0.1:${testPort}/testdb`

    const { exitCode, stderr, stdout } = await runCLI(
      `create ${containerName} --from "${connectionString}" --no-start`,
    )

    // 命令可能因连接失败而报错（这是预期的，因为该端口上没有运行服务器），
    // 但至少应能识别出 PostgreSQL 引擎
    // 目前，我们验证命令解析是否正常工作
    console.log(`   --from 命令退出码：${exitCode}`)

    // 如果成功（在没有运行服务器的情况下不太可能），验证是否为 PostgreSQL
    if (exitCode === 0) {
      const { stdout: infoOut } = await runCLI(`info ${containerName} --json`)
      const info = JSON.parse(infoOut)
      assertEqual(info.engine, 'postgresql', '引擎应为 postgresql')
      console.log('   已从连接字符串正确推断引擎')

      // 清理
      await runCLI(`delete ${containerName} --force --yes`)
    } else {
      // 检查错误消息是否提及连接或 PostgreSQL
      const output = (stdout + stderr).toLowerCase()
      assert(
        output.includes('postgres') ||
          output.includes('connect') ||
          output.includes('error'),
        '错误应提及 PostgreSQL 或连接问题',
      )
      console.log('   已尝试连接字符串解析（服务器未运行）')
    }
  })

  it('应拒绝无效的连接字符串格式', async () => {
    const { exitCode } = await runCLI(
      `create ${containerName} --from "not-a-valid-url"`,
    )
    assert(exitCode !== 0, '无效的连接字符串应失败')
    console.log('   对无效连接字符串给出了恰当的错误提示')
  })
})

describe('CLI 错误处理', () => {
  it('应对不存在的容器给出恰当错误', async () => {
    const { exitCode, stdout, stderr } = await runCLI(
      'info non-existent-container-xyz',
    )
    // 检查退出码或输出中的错误/提示信息
    // 注意：当没有容器时，info 返回 "No containers found" 且退出码为 0
    // 当存在容器但指定的容器不存在时，info 返回 "not found" 且退出码为 1
    const output = (stdout + stderr).toLowerCase()
    const hasExpectedBehavior =
      exitCode !== 0 ||
      output.includes('not found') ||
      output.includes('does not exist') ||
      output.includes('no containers found') ||
      output.includes('error')
    assert(
      hasExpectedBehavior,
      `应妥善处理不存在的容器。exitCode=${exitCode}, stdout=${stdout.slice(0, 100)}, stderr=${stderr.slice(0, 100)}`,
    )
    console.log('   对不存在的容器给出了恰当的错误提示')
  })

  it('应对无效的容器名称给出恰当错误', async () => {
    const { exitCode } = await runCLI('create 123-invalid --engine postgresql')
    assert(exitCode !== 0, '无效的容器名称应失败')
    console.log('   对无效的容器名称给出了恰当的错误提示')
  })

  it('应对未知引擎给出恰当错误', async () => {
    const { exitCode } = await runCLI('create test-unknown --engine fakedb')
    assert(exitCode !== 0, '未知引擎应失败')
    console.log('   对未知引擎给出了恰当的错误提示')
  })
})

describe('CLI 备份与恢复工作流', () => {
  let containerName: string
  let testPort: number
  let backupFilename: string
  const testDir = join(__dirname, '../.test-cli-backup')

  before(async () => {
    console.log('\n 正在清理测试容器...')
    await cleanupTestContainers()
    await mkdir(testDir, { recursive: true })

    const ports = await findConsecutiveFreePorts(1, TEST_PORTS.postgresql.base)
    testPort = ports[0]
    containerName = generateTestName('clipgbackup')
    backupFilename = `${containerName}-backup`
    console.log(`   使用容器：${containerName}，端口：${testPort}`)
  })

  after(async () => {
    console.log('\n 最终清理...')
    await cleanupTestContainers()
    if (existsSync(testDir)) {
      await rm(testDir, { recursive: true, force: true })
    }
  })

  it('应为备份测试创建并启动 PostgreSQL 容器', async () => {
    console.log(`\n 正在创建容器 "${containerName}"...`)

    const { exitCode, stderr, stdout } = await runCLI(
      `create ${containerName} --engine postgresql --port ${testPort} --start`,
    )

    assert(exitCode === 0, `创建应成功。stderr: ${stderr}, stdout: ${stdout}`)

    // 等待 PostgreSQL 就绪
    const ready = await waitForReady(Engine.PostgreSQL, testPort)
    assert(ready, 'PostgreSQL 应已就绪')
    console.log('   容器已创建并启动')
  })

  it('应创建测试数据', async () => {
    // 创建表并插入数据
    const { exitCode: createExit, stderr: createErr } = await runCLI(
      `run ${containerName} --sql "CREATE TABLE backup_test (id SERIAL PRIMARY KEY, name TEXT)"`,
    )
    assert(createExit === 0, `创建表应成功。stderr: ${createErr}`)

    const { exitCode: insertExit, stderr: insertErr } = await runCLI(
      `run ${containerName} --sql "INSERT INTO backup_test (name) VALUES ('test1'), ('test2'), ('test3')"`,
    )
    assert(insertExit === 0, `插入应成功。stderr: ${insertErr}`)
    console.log('   测试数据已创建')
  })

  it('应通过 CLI 创建 SQL 备份', async () => {
    console.log(`\n 正在创建备份到 "${testDir}"...`)

    const { exitCode, stderr, stdout } = await runCLI(
      `backup ${containerName} --output "${testDir}" --name "${backupFilename}" --format sql`,
    )

    assert(exitCode === 0, `备份应成功。stderr: ${stderr}, stdout: ${stdout}`)

    // 备份文件将自动添加 .sql 扩展名
    const backupPath = join(testDir, `${backupFilename}.sql`)
    assert(existsSync(backupPath), `备份文件应存在于 ${backupPath}`)
    console.log('   SQL 备份已创建')
  })

  it('应创建带 JSON 输出的备份', async () => {
    const jsonBackupName = `${containerName}-json`
    const { stdout, exitCode, stderr } = await runCLI(
      `backup ${containerName} --output "${testDir}" --name "${jsonBackupName}" --format sql --json`,
    )

    assert(exitCode === 0, `带 --json 的备份应成功。stderr: ${stderr}`)

    // JSON 输出应可解析
    const parsed = JSON.parse(stdout)
    assert(parsed.path !== undefined, 'JSON 应包含 path')
    assert(parsed.size !== undefined, 'JSON 应包含 size')
    assert(parsed.format !== undefined, 'JSON 应包含 format')
    console.log('   JSON 备份输出已验证')
  })

  it('应通过 CLI 将备份恢复到新数据库', async () => {
    console.log(`\n 正在将备份恢复到新数据库...`)

    const backupPath = join(testDir, `${backupFilename}.sql`)
    const { exitCode, stderr, stdout } = await runCLI(
      `restore ${containerName} "${backupPath}" --database restored_db`,
    )

    assert(exitCode === 0, `恢复应成功。stderr: ${stderr}, stdout: ${stdout}`)
    console.log('   备份已恢复到新数据库')
  })

  it('应验证恢复的数据', async () => {
    const { stdout, exitCode, stderr } = await runCLI(
      `run ${containerName} --database restored_db --sql "SELECT COUNT(*) as count FROM backup_test"`,
    )

    assert(exitCode === 0, `查询应成功。stderr: ${stderr}`)
    // 输出应包含计数（psql 对 COUNT 的输出为 "3"）
    assert(stdout.includes('3'), `恢复的数据库中应有 3 行。stdout: ${stdout}`)
    console.log('   恢复的数据已验证')
  })

  it('应使用 --force 替换现有数据库进行恢复', async () => {
    console.log(`\n 正在使用 --force 替换数据库进行恢复...`)

    const backupPath = join(testDir, `${backupFilename}.sql`)
    const { exitCode, stderr, stdout } = await runCLI(
      `restore ${containerName} "${backupPath}" --database restored_db --force`,
    )

    assert(
      exitCode === 0,
      `带 --force 的恢复应成功。stderr: ${stderr}, stdout: ${stdout}`,
    )
    console.log('   已使用 --force 恢复备份')
  })

  it('应为克隆测试停止容器', async () => {
    const { exitCode, stderr } = await runCLI(`stop ${containerName}`)
    assert(exitCode === 0, `停止应成功。stderr: ${stderr}`)
    console.log('   容器已停止')
  })

  it('应删除备份测试容器', async () => {
    const { exitCode, stderr } = await runCLI(
      `delete ${containerName} --force --yes`,
    )
    assert(exitCode === 0, `删除应成功。stderr: ${stderr}`)
    console.log('   容器已删除')
  })
})

describe('CLI 克隆工作流', () => {
  let sourceContainer: string
  let cloneContainer: string
  let testPort: number

  before(async () => {
    console.log('\n 正在清理测试容器...')
    await cleanupTestContainers()

    const ports = await findConsecutiveFreePorts(1, TEST_PORTS.postgresql.base)
    testPort = ports[0]
    sourceContainer = generateTestName('clisource')
    cloneContainer = generateTestName('cliclone')
    console.log(
      `   使用源容器：${sourceContainer}，克隆容器：${cloneContainer}`,
    )
  })

  after(async () => {
    console.log('\n 最终清理...')
    await cleanupTestContainers()
  })

  it('应为克隆测试创建源容器', async () => {
    console.log(`\n 正在创建源容器 "${sourceContainer}"...`)

    const { exitCode, stderr, stdout } = await runCLI(
      `create ${sourceContainer} --engine postgresql --port ${testPort} --no-start`,
    )

    assert(exitCode === 0, `创建应成功。stderr: ${stderr}, stdout: ${stdout}`)
    console.log('   源容器已创建')
  })

  it('应通过 CLI 克隆已停止的容器', async () => {
    console.log(`\n 正在将 "${sourceContainer}" 克隆到 "${cloneContainer}"...`)

    const { exitCode, stderr, stdout } = await runCLI(
      `clone ${sourceContainer} ${cloneContainer}`,
    )

    assert(exitCode === 0, `克隆应成功。stderr: ${stderr}, stdout: ${stdout}`)
    console.log('   容器已克隆')
  })

  it('应在列表中显示克隆的容器', async () => {
    const { stdout, stderr, exitCode } = await runCLI('list --json')
    assert(exitCode === 0, `List 应成功。stdout: ${stdout}, stderr: ${stderr}`)

    const containers = JSON.parse(stdout)
    const containerNames = containers.map((c: { name: string }) => c.name)
    console.log(`   所有容器：${containerNames.join(', ') || '(无)'}`)

    const source = containers.find(
      (c: { name: string }) => c.name === sourceContainer,
    )
    const clone = containers.find(
      (c: { name: string }) => c.name === cloneContainer,
    )

    assert(
      source,
      `源容器应存在。正在查找：${sourceContainer}，实际：${containerNames.join(', ')}`,
    )
    assert(
      clone,
      `克隆容器应存在。正在查找：${cloneContainer}，实际：${containerNames.join(', ')}`,
    )
    assertEqual(clone.engine, 'postgresql', '克隆的引擎应为 postgresql')
    console.log('   两个容器都出现在列表中')
  })

  it('应显示包含 clonedFrom 的克隆信息', async () => {
    const { stdout, stderr, exitCode } = await runCLI(
      `info ${cloneContainer} --json`,
    )
    assert(exitCode === 0, `Info 应成功。stdout: ${stdout}, stderr: ${stderr}`)

    const info = JSON.parse(stdout)
    assertEqual(info.clonedFrom, sourceContainer, 'clonedFrom 应引用源容器')
    console.log('   克隆信息显示了 clonedFrom 字段')
  })

  it('应删除源容器和克隆容器', async () => {
    const {
      exitCode: deleteSource,
      stderr: srcErr,
      stdout: srcOut,
    } = await runCLI(`delete ${sourceContainer} --force --yes`)
    assert(
      deleteSource === 0,
      `删除源容器应成功。stdout: ${srcOut}, stderr: ${srcErr}`,
    )

    const {
      exitCode: deleteClone,
      stderr: cloneErr,
      stdout: cloneOut,
    } = await runCLI(`delete ${cloneContainer} --force --yes`)
    assert(
      deleteClone === 0,
      `删除克隆容器应成功。stdout: ${cloneOut}, stderr: ${cloneErr}`,
    )
    console.log('   容器已删除')
  })
})
