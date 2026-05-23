// 系统集成测试的测试辅助函数

import { exec } from 'child_process'
import { promisify } from 'util'
import { existsSync, readdirSync } from 'fs'
import { rm } from 'fs/promises'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { containerManager } from '../../core/container-manager'
import { portManager } from '../../core/port-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { paths } from '../../config/paths'
import { isWindows } from '../../core/platform-service'
import { Engine, type QueryResult } from '../../types'
import { compareVersions } from '../../core/version-utils'

const execAsync = promisify(exec)

/**
 * 为 MongoDB 兼容引擎（MongoDB、FerretDB）构建并执行 mongosh 命令
 * 处理平台特定的 shell 转义
 */
async function runMongoshCommand(
  engine: Engine,
  port: number,
  database: string,
  script: string,
): Promise<{ stdout: string; stderr: string }> {
  const engineImpl = getEngine(engine)
  const mongoshPath = await engineImpl.getMongoshPath().catch(() => 'mongosh')

  let cmd: string
  if (isWindows()) {
    const escaped = script.replace(/"/g, '\\"')
    cmd = `"${mongoshPath}" --host 127.0.0.1 --port ${port} ${database} --eval "${escaped}" --quiet`
  } else {
    const escaped = script.replace(/'/g, "'\\''")
    cmd = `"${mongoshPath}" --host 127.0.0.1 --port ${port} ${database} --eval '${escaped}' --quiet`
  }
  return execAsync(cmd)
}

/**
 * 为 MongoDB 兼容引擎（MongoDB、FerretDB）通过 mongosh 执行 JavaScript 文件
 */
async function runMongoshFile(
  engine: Engine,
  port: number,
  database: string,
  filePath: string,
): Promise<{ stdout: string; stderr: string }> {
  const engineImpl = getEngine(engine)
  const mongoshPath = await engineImpl.getMongoshPath().catch(() => 'mongosh')
  const cmd = `"${mongoshPath}" --host 127.0.0.1 --port ${port} ${database} --file "${filePath}"`
  return execAsync(cmd)
}

// 默认测试端口配置
export const TEST_PORTS = {
  postgresql: { base: 5454, clone: 5456, renamed: 5455 },
  mysql: { base: 3333, clone: 3335, renamed: 3334, authBase: 3336 },
  mariadb: { base: 3340, clone: 3342, renamed: 3341 },
  mongodb: { base: 27050, clone: 27052, renamed: 27051 },
  ferretdb: { base: 27060, clone: 27062, renamed: 27061 },
  'ferretdb-v1': { base: 27070, clone: 27072, renamed: 27071 },
  redis: { base: 6399, clone: 6401, renamed: 6400 },
  valkey: { base: 6410, clone: 6412, renamed: 6411 },
  clickhouse: { base: 9050, clone: 9052, renamed: 9051 },
  qdrant: { base: 6350, clone: 6352, renamed: 6351 },
  meilisearch: { base: 7710, clone: 7712, renamed: 7711 },
  couchdb: { base: 5990, clone: 5992, renamed: 5991 },
  cockroachdb: { base: 26260, clone: 26262, renamed: 26261 },
  surrealdb: { base: 8010, clone: 8012, renamed: 8011 },
  questdb: { base: 8820, clone: 8822, renamed: 8821 },
  typedb: { base: 1730, clone: 1732, renamed: 1731 },
  influxdb: { base: 8087, clone: 8089, renamed: 8088 },
  weaviate: { base: 8090, clone: 8092, renamed: 8091 },
  tigerbeetle: { base: 3090, clone: 3092, renamed: 3091 },
  libsql: { base: 8180, clone: 8182, renamed: 8181 },
}

// 各引擎的默认测试版本
// 供需要版本号的辅助函数调用引擎方法时使用
export const TEST_VERSIONS = {
  cockroachdb: '25',
  surrealdb: '2',
  questdb: '9',
  typedb: '3',
}

/**
 * 生成唯一的测试容器名称
 * 容器名称必须以字母开头。
 * 使用下划线代替连字符以兼容 PostgreSQL
 * （PostgreSQL 数据库名不能包含连字符）
 */
export function generateTestName(prefix = 'test'): string {
  const uuid = randomUUID().slice(0, 8).replace(/-/g, '')
  return `${prefix}_${uuid}`
}

// 从起始端口开始查找 N 个连续的空闲端口
export async function findConsecutiveFreePorts(
  count: number,
  startPort: number,
): Promise<number[]> {
  const ports: number[] = []
  let currentPort = startPort

  while (ports.length < count) {
    const available = await portManager.isPortAvailable(currentPort)
    if (available) {
      // 检查能否从该端口获取剩余数量的连续端口
      let consecutiveAvailable = true
      for (let i = 1; i < count - ports.length; i++) {
        if (!(await portManager.isPortAvailable(currentPort + i))) {
          consecutiveAvailable = false
          break
        }
      }

      if (consecutiveAvailable || ports.length === count - 1) {
        ports.push(currentPort)
        currentPort++
      } else {
        // 跳到下一个端口并重试
        currentPort++
        ports.length = 0 // 重置并重新开始
      }
    } else {
      currentPort++
      ports.length = 0 // 遇到占用端口则重置
    }

    // 安全阀，防止无限循环
    if (currentPort > startPort + 100) {
      throw new Error(
        `无法在从 ${startPort} 开始的范围内找到 ${count} 个连续空闲端口`,
      )
    }
  }

  return ports
}

/**
 * 清理所有测试容器
 * 匹配带有测试前缀（cli*、test*）且后跟下划线和 UUID 的容器
 */
export async function cleanupTestContainers(): Promise<string[]> {
  const containers = await containerManager.list()
  // 匹配测试命名模式：包含 "-test" 并后跟 _uuid 的容器
  // 示例：pg-test_12345678、mysql-test-clone_abcd1234、redis-test-renamed_12345678
  // 同时匹配旧模式：clipg_12345678、test_abcd1234
  const testPattern = /(-test|^cli|^test)[a-z-]*_[a-f0-9]+$/i
  let testContainers = containers.filter((c) => testPattern.test(c.name))

  // 在 Windows 上，跳过清理 CockroachDB、SurrealDB 和 QuestDB 容器
  // 这些引擎使用内存映射文件（RocksDB/SurrealKV/QuestDB 列式存储），
  // Windows 会长时间持有文件句柄（100+ 秒），导致清理挂起
  if (isWindows()) {
    testContainers = testContainers.filter(
      (c) =>
        c.engine !== Engine.CockroachDB &&
        c.engine !== Engine.SurrealDB &&
        c.engine !== Engine.QuestDB &&
        c.engine !== Engine.TypeDB,
    )
  }

  const deleted: string[] = []
  for (const container of testContainers) {
    try {
      // 若正在运行则停止
      const running = await processManager.isRunning(container.name, {
        engine: container.engine,
      })
      if (running) {
        const engine = getEngine(container.engine)
        const config = await containerManager.getConfig(container.name)
        if (config) {
          await engine.stop(config)
          // Windows 上等待容器完全停止
          // Windows 释放端口和文件句柄较慢
          if (isWindows()) {
            await new Promise((resolve) => setTimeout(resolve, 5000))
          }
        }
      }

      // Windows 上删除容器带重试
      // Windows 可能在进程终止后较长时间内仍持有文件句柄
      let deleteAttempts = isWindows() ? 3 : 1
      while (deleteAttempts > 0) {
        try {
          await containerManager.delete(container.name, { force: true })
          deleted.push(container.name)
          break
        } catch {
          deleteAttempts--
          if (deleteAttempts > 0) {
            await new Promise((resolve) => setTimeout(resolve, 2000))
          }
          // 若所有重试均失败，静默继续（这仅是清理）
        }
      }
    } catch {
      // 清理过程中忽略错误
    }
  }

  // 同时清理孤立的 SQLite 容器目录
  // （存在但不在注册表中的目录）
  const sqliteContainersDir = paths.getEngineContainersPath('sqlite')
  if (existsSync(sqliteContainersDir)) {
    const dirs = readdirSync(sqliteContainersDir, { withFileTypes: true })
    for (const dir of dirs) {
      if (dir.isDirectory() && testPattern.test(dir.name)) {
        try {
          const dirPath = `${sqliteContainersDir}/${dir.name}`
          await rm(dirPath, { recursive: true, force: true })
          if (!deleted.includes(dir.name)) {
            deleted.push(dir.name)
          }
        } catch {
          // 清理过程中忽略错误
        }
      }
    }
  }

  return deleted
}

/**
 * 对数据库执行 SQL 并返回结果
 * 对于 SQLite，database 参数是文件路径
 * 对于 MongoDB，sql 是 JavaScript 代码
 * 对于 SurrealDB，options.namespace 是必需的（由容器名派生）
 */
export async function executeSQL(
  engine: Engine,
  port: number,
  database: string,
  sql: string,
  options?: { namespace?: string },
): Promise<{ stdout: string; stderr: string }> {
  if (engine === Engine.SQLite) {
    // 对于 SQLite，database 是文件路径
    // 如果可用，使用已配置/内置的 sqlite3
    const engineImpl = getEngine(engine)
    const sqlite3Path = await engineImpl.getSqlite3Path().catch(() => null)
    if (!sqlite3Path) {
      throw new Error('未找到 sqlite3。请运行：spindb engines download sqlite')
    }
    const cmd = `"${sqlite3Path}" "${database}" "${sql.replace(/"/g, '\\"')}"`
    return execAsync(cmd)
  } else if (engine === Engine.MySQL) {
    const engineImpl = getEngine(engine)
    // 如果可用，使用已配置/内置的 mysql，否则回退到 PATH 中的 `mysql`
    const mysqlPath = await engineImpl.getMysqlClientPath().catch(() => 'mysql')
    const cmd = `"${mysqlPath}" -h 127.0.0.1 -P ${port} -u root ${database} -e "${sql.replace(/"/g, '\\"')}"`
    return execAsync(cmd)
  } else if (engine === Engine.MariaDB) {
    const engineImpl = getEngine(engine)
    // 如果可用，使用已配置/内置的 mariadb，否则回退到 PATH 中的 `mariadb`
    const mariadbPath = await engineImpl
      .getMariadbClientPath()
      .catch(() => 'mariadb')
    const cmd = `"${mariadbPath}" -h 127.0.0.1 -P ${port} -u root ${database} -e "${sql.replace(/"/g, '\\"')}"`
    return execAsync(cmd)
  } else if (engine === Engine.MongoDB || engine === Engine.FerretDB) {
    // MongoDB 和 FerretDB 使用 mongosh（FerretDB 以 --no-auth 模式运行用于本地开发）
    return runMongoshCommand(engine, port, database, sql)
  } else if (engine === Engine.Redis) {
    const engineImpl = getEngine(engine)
    // 如果可用，使用已配置/内置的 redis-cli
    const redisCliPath = await engineImpl
      .getRedisCliPath()
      .catch(() => 'redis-cli')
    // 对于 Redis，sql 是一个 Redis 命令
    const cmd = `"${redisCliPath}" -h 127.0.0.1 -p ${port} -n ${database} ${sql}`
    return execAsync(cmd)
  } else if (engine === Engine.Valkey) {
    const engineImpl = getEngine(engine)
    // 如果可用，使用已配置/内置的 valkey-cli
    const valkeyCliPath = await engineImpl
      .getValkeyCliPath()
      .catch(() => 'valkey-cli')
    // 对于 Valkey，sql 是兼容 Redis 的命令
    const cmd = `"${valkeyCliPath}" -h 127.0.0.1 -p ${port} -n ${database} ${sql}`
    return execAsync(cmd)
  } else if (engine === Engine.ClickHouse) {
    const engineImpl = getEngine(engine)
    // 如果可用，使用已配置/内置的 clickhouse
    const clickhousePath = await engineImpl
      .getClickHouseClientPath()
      .catch(() => 'clickhouse')
    // 对于 ClickHouse，使用 clickhouse client
    const cmd = `"${clickhousePath}" client --host 127.0.0.1 --port ${port} --database ${database} --query "${sql.replace(/"/g, '\\"')}"`
    return execAsync(cmd)
  } else if (engine === Engine.CockroachDB) {
    const engineImpl = getEngine(engine)
    // 如果可用，使用已配置/内置的 cockroach
    const cockroachPath = await engineImpl
      .getCockroachPath(TEST_VERSIONS.cockroachdb)
      .catch(() => 'cockroach')
    const config = (await containerManager.list()).find(
      (c) => c.engine === engine && c.port === port,
    )
    if (!config) {
      throw new Error(`无法找到端口 ${port} 对应的 CockroachDB 容器配置`)
    }
    const certsDir = join(
      paths.getContainerPath(config.name, { engine }),
      'certs',
    )
    const cmd = `"${cockroachPath}" sql --certs-dir "${certsDir}" --user root --host 127.0.0.1:${port} --database ${database} --execute "${sql.replace(/"/g, '\\"')}"`
    return execAsync(cmd)
  } else if (engine === Engine.SurrealDB) {
    const engineImpl = getEngine(engine)
    // 如果可用，使用已配置/内置的 surreal
    const surrealPath = await engineImpl
      .getSurrealPath(TEST_VERSIONS.surrealdb)
      .catch(() => 'surreal')
    // 对于 SurrealDB，使用 surreal sql 并通过管道输入
    // SurrealDB 需要命名空间 — 必须通过 options 提供（从容器名派生，将 - 替换为 _）
    if (!options?.namespace) {
      throw new Error(
        'SurrealDB 需要 options.namespace（从容器名派生，将 - 替换为 _）',
      )
    }
    // 使用 spawn 并通过 stdin 输入，而非 echo 管道，以兼容跨平台
    const { spawn } = await import('child_process')
    return new Promise((resolve, reject) => {
      const args = [
        'sql',
        '--endpoint',
        `ws://127.0.0.1:${port}`,
        '--user',
        'root',
        '--pass',
        'root',
        '--ns',
        options.namespace!,
        '--db',
        database,
        '--hide-welcome',
      ]
      const proc = spawn(surrealPath, args, { stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString()
      })
      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString()
      })
      proc.on('close', (code) => {
        if (code === 0) resolve({ stdout, stderr })
        else reject(new Error(stderr || `退出码 ${code}`))
      })
      proc.on('error', reject)
      proc.stdin.write(sql)
      proc.stdin.end()
    })
  } else if (engine === Engine.QuestDB) {
    // QuestDB 使用 PostgreSQL 有线协议，但凭据不同
    const connectionString = `postgresql://admin:quest@127.0.0.1:${port}/${database}`
    const engineImpl = getEngine(Engine.PostgreSQL)
    const psqlPath = await engineImpl.getPsqlPath().catch(() => 'psql')
    const cmd = `"${psqlPath}" "${connectionString}" -c "${sql.replace(/"/g, '\\"')}"`
    return execAsync(cmd)
  } else if (engine === Engine.TypeDB) {
    // TypeDB console --command 模式不支持多步事务流；
    // 每个 --command 都是独立的命令。使用临时脚本来执行查询。
    const engineImpl = getEngine(Engine.TypeDB)
    const consolePath = await engineImpl.getTypeDBConsolePath(
      TEST_VERSIONS.typedb,
    )
    const { getConsoleBaseArgs } =
      await import('../../engines/typedb/cli-utils')
    const { spawn } = await import('child_process')
    const { writeFile, unlink } = await import('fs/promises')
    const { tmpdir } = await import('os')
    const { join } = await import('path')

    // 检测事务类型：模式（DEFINE/UNDEFINE）、写入（INSERT/DELETE/PUT）或读取
    // 在整个查询中检查，而不仅是在开头，以处理 MATCH ... DELETE/INSERT 模式
    const upperSql = sql.trim().toUpperCase()
    const isSchema = /\b(?:DEFINE|UNDEFINE)\b/.test(upperSql)
    const isWrite = /\b(?:INSERT|DELETE|PUT)\b/.test(upperSql)
    const txType = isSchema ? 'schema' : isWrite ? 'write' : 'read'
    const txEnd = isSchema || isWrite ? 'commit' : 'close'
    const scriptContent = `transaction ${txType} ${database}\n\n${sql}\n\n${txEnd}\n`
    const tempScript = join(
      tmpdir(),
      `spindb-typedb-test-${Date.now()}-${Math.random().toString(36).slice(2)}.tqls`,
    )

    try {
      await writeFile(tempScript, scriptContent, 'utf-8')
      const args = [...getConsoleBaseArgs(port), '--script', tempScript]

      return await new Promise((resolve, reject) => {
        const proc = spawn(consolePath, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let stdout = ''
        let stderr = ''
        proc.stdout.on('data', (data: Buffer) => {
          stdout += data.toString()
        })
        proc.stderr.on('data', (data: Buffer) => {
          stderr += data.toString()
        })
        proc.on('close', (code) => {
          if (code === 0) resolve({ stdout, stderr })
          else reject(new Error(stderr || `退出码 ${code}`))
        })
        proc.on('error', reject)
      })
    } finally {
      await unlink(tempScript).catch(() => {})
    }
  } else if (engine === Engine.LibSQL) {
    throw new Error('libSQL 使用 REST API；请改用 libSQL API 辅助函数')
  } else if (engine === Engine.InfluxDB) {
    throw new Error('InfluxDB 使用 REST API；请改用 InfluxDB REST 辅助函数')
  } else if (engine === Engine.Weaviate) {
    throw new Error('Weaviate 使用 REST API；请改用 Weaviate REST 辅助函数')
  } else if (engine === Engine.TigerBeetle) {
    throw new Error(
      'TigerBeetle 使用自定义二进制协议；没有可用的 SQL/REST 接口',
    )
  } else {
    const connectionString = `postgresql://postgres@127.0.0.1:${port}/${database}`
    const engineImpl = getEngine(engine)
    // 如果可用，使用已配置/内置的 psql，否则回退到 PATH 中的 `psql`
    const psqlPath = await engineImpl.getPsqlPath().catch(() => 'psql')
    const cmd = `"${psqlPath}" "${connectionString}" -c "${sql.replace(/"/g, '\\"')}"`
    return execAsync(cmd)
  }
}

/**
 * 对数据库执行 SQL 文件
 * 对于 SQLite，database 参数是文件路径
 * 对于 MongoDB，文件应为 JavaScript 文件
 * 对于 SurrealDB，options.namespace 是必需的（由容器名派生）
 */
export async function executeSQLFile(
  engine: Engine,
  port: number,
  database: string,
  filePath: string,
  options?: { namespace?: string },
): Promise<{ stdout: string; stderr: string }> {
  if (engine === Engine.SQLite) {
    // 对于 SQLite，database 是文件路径
    // 如果可用，使用已配置/内置的 sqlite3
    const engineImpl = getEngine(engine)
    const sqlite3Path = await engineImpl.getSqlite3Path().catch(() => null)
    if (!sqlite3Path) {
      throw new Error('未找到 sqlite3。请运行：spindb engines download sqlite')
    }
    const cmd = `"${sqlite3Path}" "${database}" < "${filePath}"`
    return execAsync(cmd)
  } else if (engine === Engine.MySQL) {
    const engineImpl = getEngine(engine)
    const mysqlPath = await engineImpl.getMysqlClientPath().catch(() => 'mysql')
    const cmd = `"${mysqlPath}" -h 127.0.0.1 -P ${port} -u root ${database} < "${filePath}"`
    return execAsync(cmd)
  } else if (engine === Engine.MariaDB) {
    const engineImpl = getEngine(engine)
    const mariadbPath = await engineImpl
      .getMariadbClientPath()
      .catch(() => 'mariadb')
    const cmd = `"${mariadbPath}" -h 127.0.0.1 -P ${port} -u root ${database} < "${filePath}"`
    return execAsync(cmd)
  } else if (engine === Engine.MongoDB || engine === Engine.FerretDB) {
    // MongoDB 和 FerretDB 使用 mongosh（FerretDB 以 --no-auth 模式运行用于本地开发）
    return runMongoshFile(engine, port, database, filePath)
  } else if (engine === Engine.Redis) {
    const engineImpl = getEngine(engine)
    const redisCliPath = await engineImpl
      .getRedisCliPath()
      .catch(() => 'redis-cli')
    // Redis 使用管道进行文件输入：redis-cli -n <db> < file.redis
    const cmd = `"${redisCliPath}" -h 127.0.0.1 -p ${port} -n ${database} < "${filePath}"`
    return execAsync(cmd)
  } else if (engine === Engine.Valkey) {
    const engineImpl = getEngine(engine)
    const valkeyCliPath = await engineImpl
      .getValkeyCliPath()
      .catch(() => 'valkey-cli')
    // Valkey 使用管道进行文件输入：valkey-cli -n <db> < file.valkey
    const cmd = `"${valkeyCliPath}" -h 127.0.0.1 -p ${port} -n ${database} < "${filePath}"`
    return execAsync(cmd)
  } else if (engine === Engine.ClickHouse) {
    const engineImpl = getEngine(engine)
    const clickhousePath = await engineImpl
      .getClickHouseClientPath()
      .catch(() => 'clickhouse')
    // ClickHouse 使用管道进行文件输入，并附带 --multiquery 标志
    const cmd = `"${clickhousePath}" client --host 127.0.0.1 --port ${port} --database ${database} --multiquery < "${filePath}"`
    return execAsync(cmd)
  } else if (engine === Engine.CockroachDB) {
    const engineImpl = getEngine(engine)
    const cockroachPath = await engineImpl
      .getCockroachPath(TEST_VERSIONS.cockroachdb)
      .catch(() => 'cockroach')
    const config = (await containerManager.list()).find(
      (c) => c.engine === engine && c.port === port,
    )
    if (!config) {
      throw new Error(`无法找到端口 ${port} 对应的 CockroachDB 容器配置`)
    }
    const certsDir = join(
      paths.getContainerPath(config.name, { engine }),
      'certs',
    )
    // CockroachDB 使用 --file 标志来执行 SQL 文件
    const cmd = `"${cockroachPath}" sql --certs-dir "${certsDir}" --user root --host 127.0.0.1:${port} --database ${database} --file "${filePath}"`
    return execAsync(cmd)
  } else if (engine === Engine.SurrealDB) {
    const engineImpl = getEngine(engine)
    const surrealPath = await engineImpl
      .getSurrealPath(TEST_VERSIONS.surrealdb)
      .catch(() => 'surreal')
    // SurrealDB 使用 surreal import 进行文件输入
    // 命名空间必须通过 options 提供（从容器名派生，将 - 替换为 _）
    if (!options?.namespace) {
      throw new Error(
        'SurrealDB 需要 options.namespace（从容器名派生，将 - 替换为 _）',
      )
    }
    const cmd = `"${surrealPath}" import --endpoint http://127.0.0.1:${port} --user root --pass root --ns ${options.namespace} --db ${database} "${filePath}"`
    return execAsync(cmd)
  } else if (engine === Engine.QuestDB) {
    // QuestDB 使用 PostgreSQL 有线协议，但凭据不同
    const connectionString = `postgresql://admin:quest@127.0.0.1:${port}/${database}`
    const engineImpl = getEngine(Engine.PostgreSQL)
    const psqlPath = await engineImpl.getPsqlPath().catch(() => 'psql')
    const cmd = `"${psqlPath}" "${connectionString}" -f "${filePath}"`
    return execAsync(cmd)
  } else if (engine === Engine.TypeDB) {
    // TypeDB 使用 console 二进制文件并通过 --script 标志执行 .tqls 文件
    const engineImpl = getEngine(Engine.TypeDB)
    const consolePath = await engineImpl.getTypeDBConsolePath(
      TEST_VERSIONS.typedb,
    )
    const { getConsoleBaseArgs } =
      await import('../../engines/typedb/cli-utils')
    const args = [...getConsoleBaseArgs(port), '--script', filePath]
    const cmd = `"${consolePath}" ${args.map((a) => `"${a}"`).join(' ')}`
    return execAsync(cmd)
  } else if (engine === Engine.LibSQL) {
    throw new Error('libSQL 使用 REST API；请改用 libSQL API 辅助函数')
  } else if (engine === Engine.InfluxDB) {
    throw new Error('InfluxDB 使用 REST API；请改用 InfluxDB REST 辅助函数')
  } else if (engine === Engine.Weaviate) {
    throw new Error('Weaviate 使用 REST API；请改用 Weaviate REST 辅助函数')
  } else if (engine === Engine.TigerBeetle) {
    throw new Error(
      'TigerBeetle 使用自定义二进制协议；没有可用的 SQL/REST 接口',
    )
  } else {
    const connectionString = `postgresql://postgres@127.0.0.1:${port}/${database}`
    const engineImpl = getEngine(engine)
    const psqlPath = await engineImpl.getPsqlPath().catch(() => 'psql')
    const cmd = `"${psqlPath}" "${connectionString}" -f "${filePath}"`
    return execAsync(cmd)
  }
}

/**
 * 查询表/集合中的行数
 * 对于 MongoDB，table 是集合名称
 */
export async function getRowCount(
  engine: Engine,
  port: number,
  database: string,
  table: string,
): Promise<number> {
  if (engine === Engine.CockroachDB) {
    const containers = await containerManager.list()
    const config =
      containers.find((c) => c.engine === engine && c.port === port) || null

    if (!config) {
      throw new Error(`无法找到端口 ${port} 对应的 CockroachDB 容器配置`)
    }

    const engineImpl = getEngine(engine)
    const result = await engineImpl.executeQuery(
      config,
      `SELECT COUNT(*) as count FROM ${table}`,
      { database },
    )

    const rawCount = result.rows[0]?.count
    const count =
      typeof rawCount === 'number'
        ? rawCount
        : Number.parseInt(String(rawCount), 10)

    if (!Number.isNaN(count)) {
      return count
    }

    throw new Error(`无法从以下内容解析 CockroachDB 行数：${rawCount}`)
  }

  if (engine === Engine.MongoDB || engine === Engine.FerretDB) {
    // MongoDB/FerretDB 对集合使用 countDocuments()
    const { stdout } = await executeSQL(
      engine,
      port,
      database,
      `db.${table}.countDocuments()`,
    )
    const num = parseInt(stdout.trim(), 10)
    if (!isNaN(num)) {
      return num
    }
    throw new Error(`无法从以下内容解析文档数：${stdout}`)
  }

  const { stdout } = await executeSQL(
    engine,
    port,
    database,
    `SELECT COUNT(*) as count FROM ${table}`,
  )

  // 从输出中解析计数
  // PostgreSQL: " count \n-------\n     5\n(1 row)\n"
  // MySQL: "count\n5\n"
  const lines = stdout.trim().split('\n')
  for (const line of lines) {
    const num = parseInt(line.trim(), 10)
    if (!isNaN(num)) {
      return num
    }
  }

  throw new Error(`无法从以下内容解析行数：${stdout}`)
}

/**
 * 获取 Redis 中匹配模式的键数量
 * 使用 DBSIZE 获取完整数据库计数（O(1)），使用 KEYS 获取过滤模式（O(N)）
 */
export async function getKeyCount(
  port: number,
  database: string,
  pattern: string,
  engine: Engine = Engine.Redis,
): Promise<number> {
  let cliPath: string
  if (engine === Engine.Valkey) {
    const engineImpl = getEngine(Engine.Valkey)
    cliPath = await engineImpl.getValkeyCliPath().catch(() => 'valkey-cli')
  } else {
    const engineImpl = getEngine(Engine.Redis)
    cliPath = await engineImpl.getRedisCliPath().catch(() => 'redis-cli')
  }

  // 使用 DBSIZE 获取完整通配符（O(1) 对比 KEYS 的 O(N)）
  if (pattern === '*' || pattern === '') {
    const { stdout } = await execAsync(
      `"${cliPath}" -h 127.0.0.1 -p ${port} -n ${database} DBSIZE`,
    )
    const count = parseInt(stdout.trim(), 10)
    if (isNaN(count)) {
      throw new Error(`无法解析 DBSIZE 输出：${stdout}`)
    }
    return count
  }

  // 使用 KEYS 获取过滤模式
  const { stdout } = await execAsync(
    `"${cliPath}" -h 127.0.0.1 -p ${port} -n ${database} KEYS "${pattern}"`,
  )
  const trimmed = stdout.trim()
  if (trimmed === '') {
    return 0
  }
  const lines = trimmed.split('\n').filter((line) => line.trim() !== '')
  return lines.length
}

// 获取 Redis 或 Valkey 中键的值
export async function getRedisValue(
  port: number,
  database: string,
  key: string,
  engine: Engine = Engine.Redis,
): Promise<string> {
  let cliPath: string
  if (engine === Engine.Valkey) {
    const engineImpl = getEngine(Engine.Valkey)
    cliPath = await engineImpl.getValkeyCliPath().catch(() => 'valkey-cli')
  } else {
    const engineImpl = getEngine(Engine.Redis)
    cliPath = await engineImpl.getRedisCliPath().catch(() => 'redis-cli')
  }
  const { stdout } = await execAsync(
    `"${cliPath}" -h 127.0.0.1 -p ${port} -n ${database} GET "${key}"`,
  )
  return stdout.trim()
}

// Valkey 值获取的别名（使用相同协议）
export async function getValkeyValue(
  port: number,
  database: string,
  key: string,
): Promise<string> {
  return getRedisValue(port, database, key, Engine.Valkey)
}

// Valkey 键计数的别名（使用相同协议）
export async function getValkeyKeyCount(
  port: number,
  database: string,
  pattern: string,
): Promise<number> {
  return getKeyCount(port, database, pattern, Engine.Valkey)
}

// 等待数据库准备好接受连接
export async function waitForReady(
  engine: Engine,
  port: number,
  timeoutMs = 30000,
  options?: { httpPort?: number },
): Promise<boolean> {
  const startTime = Date.now()
  const checkInterval = 500

  while (Date.now() - startTime < timeoutMs) {
    try {
      if (engine === Engine.MySQL || engine === Engine.MariaDB) {
        // 优先使用已配置/内置的 mysqladmin
        const engineImpl = getEngine(engine)
        const mysqladmin = await engineImpl
          .getMysqladminPath()
          .catch(() => 'mysqladmin')
        await execAsync(`"${mysqladmin}" -h 127.0.0.1 -P ${port} -u root ping`)
      } else if (engine === Engine.MongoDB || engine === Engine.FerretDB) {
        // 使用 mongosh 来 ping MongoDB/FerretDB（两者都使用 MongoDB 有线协议）
        const engineImpl = getEngine(engine)
        const mongoshPath = await engineImpl
          .getMongoshPath()
          .catch(() => 'mongosh')
        // Windows 使用双引号，Unix 使用单引号进行 shell 转义
        const pingScript = 'db.runCommand({ping:1})'
        let cmd: string
        if (isWindows()) {
          cmd = `"${mongoshPath}" --host 127.0.0.1 --port ${port} --eval "${pingScript}" --quiet`
        } else {
          cmd = `"${mongoshPath}" --host 127.0.0.1 --port ${port} --eval '${pingScript}' --quiet`
        }
        await execAsync(cmd, { timeout: 5000 })
      } else if (engine === Engine.Redis) {
        // 使用 redis-cli 来 ping Redis
        const engineImpl = getEngine(engine)
        const redisCliPath = await engineImpl
          .getRedisCliPath()
          .catch(() => 'redis-cli')
        const { stdout } = await execAsync(
          `"${redisCliPath}" -h 127.0.0.1 -p ${port} PING`,
          { timeout: 5000 },
        )
        if (stdout.trim() === 'PONG') {
          return true
        }
      } else if (engine === Engine.Valkey) {
        // 使用 valkey-cli 来 ping Valkey
        const engineImpl = getEngine(engine)
        const valkeyCliPath = await engineImpl
          .getValkeyCliPath()
          .catch(() => 'valkey-cli')
        const { stdout } = await execAsync(
          `"${valkeyCliPath}" -h 127.0.0.1 -p ${port} PING`,
          { timeout: 5000 },
        )
        if (stdout.trim() === 'PONG') {
          return true
        }
      } else if (engine === Engine.ClickHouse) {
        // 使用 clickhouse client 来 ping ClickHouse
        const engineImpl = getEngine(engine)
        const clickhousePath = await engineImpl
          .getClickHouseClientPath()
          .catch(() => 'clickhouse')
        await execAsync(
          `"${clickhousePath}" client --host 127.0.0.1 --port ${port} --query "SELECT 1"`,
          { timeout: 5000 },
        )
      } else if (engine === Engine.CockroachDB) {
        const config = (await containerManager.list()).find(
          (c) => c.engine === engine && c.port === port,
        )
        if (!config) {
          throw new Error(`无法找到端口 ${port} 对应的 CockroachDB 容器配置`)
        }
        const status = await getEngine(engine).status(config)
        if (!status.running) {
          throw new Error(status.message || 'CockroachDB 未就绪')
        }
        return true
      } else if (engine === Engine.Qdrant) {
        // 使用 fetch 带超时地 ping Qdrant REST API
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 5000)
        try {
          const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
            signal: controller.signal,
          })
          clearTimeout(timeoutId)
          if (response.ok) {
            return true
          }
        } catch {
          clearTimeout(timeoutId)
          throw new Error('Qdrant 健康检查失败或超时')
        }
      } else if (engine === Engine.Meilisearch) {
        // 使用 fetch 带超时地 ping Meilisearch REST API
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 5000)
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health`, {
            signal: controller.signal,
          })
          clearTimeout(timeoutId)
          if (response.ok) {
            return true
          }
        } catch {
          clearTimeout(timeoutId)
          throw new Error('Meilisearch 健康检查失败或超时')
        }
      } else if (engine === Engine.CouchDB) {
        // CouchDB 的 HTTP 监听器在集群机制（mem3/fabric）完成引导之前就会响应 `GET /`。
        // 使用 `/_up` 加上一个模拟的 404 探测来确认节点确实已准备好处理数据库查询。
        // 否则，在慢速运行器上（尤其是 macOS x64 GHA），恢复/PUT 请求可能会命中一个半初始化的节点并静默失败。
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 5000)
        try {
          const upResponse = await fetch(`http://127.0.0.1:${port}/_up`, {
            signal: controller.signal,
          })
          if (!upResponse.ok) {
            clearTimeout(timeoutId)
            throw new Error(`CouchDB /_up 返回 ${upResponse.status}，未就绪`)
          }
          const upData = (await upResponse.json()) as { status?: string }
          if (upData?.status !== 'ok') {
            clearTimeout(timeoutId)
            throw new Error(`CouchDB /_up 状态=${upData?.status}，未就绪`)
          }
          const probeResponse = await fetch(
            `http://127.0.0.1:${port}/_spindb_test_probe`,
            { signal: controller.signal },
          )
          clearTimeout(timeoutId)
          if (probeResponse.status === 404 || probeResponse.status === 401) {
            return true
          }
          throw new Error(
            `CouchDB 数据库查询探测返回 ${probeResponse.status}，集群未就绪`,
          )
        } catch {
          clearTimeout(timeoutId)
          throw new Error('CouchDB 健康检查失败或超时')
        }
      } else if (engine === Engine.SurrealDB) {
        // 使用 surreal isready 来 ping SurrealDB
        const engineImpl = getEngine(engine)
        const surrealPath = await engineImpl
          .getSurrealPath(TEST_VERSIONS.surrealdb)
          .catch(() => 'surreal')
        await execAsync(
          `"${surrealPath}" isready --endpoint http://127.0.0.1:${port}`,
          { timeout: 5000 },
        )
      } else if (engine === Engine.QuestDB) {
        // 通过 PostgreSQL 有线协议使用 psql 来 ping QuestDB
        const engineImpl = getEngine(Engine.PostgreSQL)
        const psqlPath = await engineImpl.getPsqlPath().catch(() => 'psql')
        await execAsync(
          `"${psqlPath}" "postgresql://admin:quest@127.0.0.1:${port}/qdb" -c "SELECT 1"`,
          { timeout: 5000 },
        )
      } else if (engine === Engine.InfluxDB) {
        // 通过 HTTP GET 到 /health 端点进行 InfluxDB 健康检查
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 5000)
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health`, {
            signal: controller.signal,
          })
          clearTimeout(timeoutId)
          if (response.ok) {
            return true
          }
        } catch {
          clearTimeout(timeoutId)
          throw new Error('InfluxDB 健康检查失败或超时')
        }
      } else if (engine === Engine.Weaviate) {
        // 通过 HTTP GET 到 /v1/.well-known/ready 进行 Weaviate 健康检查
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 5000)
        try {
          const response = await fetch(
            `http://127.0.0.1:${port}/v1/.well-known/ready`,
            { signal: controller.signal },
          )
          clearTimeout(timeoutId)
          if (response.ok) {
            return true
          }
        } catch {
          clearTimeout(timeoutId)
          throw new Error('Weaviate 健康检查失败或超时')
        }
      } else if (engine === Engine.LibSQL) {
        // 使用 fetch 带超时地 ping libSQL REST API
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 5000)
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health`, {
            signal: controller.signal,
          })
          clearTimeout(timeoutId)
          if (response.ok) {
            return true
          }
        } catch {
          clearTimeout(timeoutId)
          throw new Error('libSQL 健康检查失败或超时')
        }
      } else if (engine === Engine.TigerBeetle) {
        // TigerBeetle：TCP 端口检查（无 HTTP 端点）
        const net = await import('net')
        await new Promise<void>((resolve, reject) => {
          const socket = new net.Socket()
          socket.setTimeout(5000)
          socket.on('connect', () => {
            socket.destroy()
            resolve()
          })
          socket.on('timeout', () => {
            socket.destroy()
            reject(new Error('TigerBeetle TCP 检查超时'))
          })
          socket.on('error', (err) => {
            socket.destroy()
            reject(err)
          })
          socket.connect(port, '127.0.0.1')
        })
      } else if (engine === Engine.TypeDB) {
        // TypeDB 健康检查：通过 HTTP GET 到 HTTP 端口
        const httpPort = options?.httpPort ?? port + 6271
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 5000)
        try {
          const response = await fetch(`http://127.0.0.1:${httpPort}/health`, {
            signal: controller.signal,
          })
          clearTimeout(timeoutId)
          if (response.status === 204) {
            return true
          }
          throw new Error(`TypeDB 健康检查返回 ${response.status}`)
        } catch {
          clearTimeout(timeoutId)
          throw new Error('TypeDB 健康检查失败或超时')
        }
      } else {
        // 优先使用引擎提供的 psql 二进制文件，以避免依赖 PATH 中的 psql（Windows 上可能不存在）
        const engineImpl = getEngine(engine)
        const psqlPath = await engineImpl.getPsqlPath().catch(() => 'psql')
        await execAsync(
          `"${psqlPath}" "postgresql://postgres@127.0.0.1:${port}/postgres" -c "SELECT 1"`,
        )
      }
      return true
    } catch {
      await new Promise((resolve) => setTimeout(resolve, checkInterval))
    }
  }

  return false
}

/**
 * 等待容器完全停止（进程终止，PID 文件移除）。
 * 这对于像重命名这样需要容器已停止的操作很重要。
 *
 * 在 Windows 上，还会等待端口释放并为文件句柄增加额外延迟。
 */
export async function waitForStopped(
  containerName: string,
  engine: Engine,
  timeoutMs = 30000,
): Promise<boolean> {
  const startTime = Date.now()
  const checkInterval = 200

  // 首先等待进程停止
  while (Date.now() - startTime < timeoutMs) {
    const running = await processManager.isRunning(containerName, { engine })
    if (!running) {
      break
    }
    await new Promise((resolve) => setTimeout(resolve, checkInterval))
  }

  // 检查是否在等待进程时超时
  const stillRunning = await processManager.isRunning(containerName, { engine })
  if (stillRunning) {
    console.log(
      `   ⚠️  waitForStopped：超时 - "${containerName}" 在 ${timeoutMs}ms 后仍在运行`,
    )
    return false
  }

  // 对于 Windows 上的 Qdrant，还需等待端口释放
  // Windows 在进程终止后释放端口较慢（TIME_WAIT 状态）
  // TCP 端口完全释放可能需要 30+ 秒
  if (engine === Engine.Qdrant && isWindows()) {
    const config = await containerManager.getConfig(containerName)
    if (config) {
      const httpPort = config.port
      const grpcPort = config.port + 1

      // 等待 HTTP 和 gRPC 端口都可用
      // 使用 60 秒以匹配引擎的端口等待超时
      const portTimeoutMs = Math.min(
        60000,
        timeoutMs - (Date.now() - startTime),
      )
      const portStartTime = Date.now()

      while (Date.now() - portStartTime < portTimeoutMs) {
        const httpAvailable = await portManager.isPortAvailable(httpPort)
        const grpcAvailable = await portManager.isPortAvailable(grpcPort)

        if (httpAvailable && grpcAvailable) {
          break
        }
        await new Promise((resolve) => setTimeout(resolve, checkInterval))
      }

      // 等待后验证端口是否实际可用
      const finalHttpAvailable = await portManager.isPortAvailable(httpPort)
      const finalGrpcAvailable = await portManager.isPortAvailable(grpcPort)
      if (!finalHttpAvailable || !finalGrpcAvailable) {
        console.log(
          `   ⚠️  waitForStopped：端口在 ${portTimeoutMs}ms 后仍被占用 - ` +
            `HTTP:${httpPort}=${finalHttpAvailable}, gRPC:${grpcPort}=${finalGrpcAvailable}`,
        )
      }
    }
  }

  // 在 Windows 上，为文件句柄释放增加额外延迟
  // 内存映射文件和 Windows 的杀毒/索引功能可能会持有句柄
  // 这有助于防止重命名/删除操作时出现 EBUSY/EPERM 错误
  if (isWindows()) {
    // SurrealDB 和 QuestDB 使用内存映射文件，在 Windows 上释放时间非常长
    // 即使进程退出后，操作系统也可能持有句柄 30+ 秒
    // QuestDB 是基于 Java 的，使用内存映射文件的列式存储
    // Qdrant 也使用持久化存储，但通常释放较快
    let extraDelay: number
    if (engine === Engine.SurrealDB || engine === Engine.QuestDB) {
      extraDelay = 30000 // 内存映射文件引擎等待 30 秒
    } else if (engine === Engine.Qdrant) {
      extraDelay = 15000 // Qdrant 等待 15 秒
    } else {
      extraDelay = 10000 // 其他引擎等待 10 秒
    }
    await new Promise((resolve) => setTimeout(resolve, extraDelay))
  }

  return true
}

/**
 * 检查容器的数据目录是否存在于文件系统中
 * 对于 SQLite，改为检查注册表
 */
export function containerDataExists(
  containerName: string,
  engine: Engine,
): boolean {
  if (engine === Engine.SQLite) {
    // SQLite 不使用容器目录，仅有注册表条目
    // 为简化测试，SQLite 返回 false
    return false
  }
  const containerPath = paths.getContainerPath(containerName, { engine })
  return existsSync(containerPath)
}

// 检查 SQLite 数据库文件是否存在
export function sqliteFileExists(filePath: string): boolean {
  return existsSync(filePath)
}

// 获取容器的连接字符串
export function getConnectionString(
  engine: Engine,
  port: number,
  database: string,
): string {
  if (engine === Engine.MySQL || engine === Engine.MariaDB) {
    return `mysql://root@127.0.0.1:${port}/${database}`
  }
  if (engine === Engine.MongoDB) {
    return `mongodb://127.0.0.1:${port}/${database}`
  }
  if (engine === Engine.FerretDB) {
    return `mongodb://127.0.0.1:${port}/${database}`
  }
  if (engine === Engine.Redis || engine === Engine.Valkey) {
    return `redis://127.0.0.1:${port}/${database}`
  }
  if (engine === Engine.ClickHouse) {
    return `clickhouse://default@127.0.0.1:${port}/${database}`
  }
  if (engine === Engine.Qdrant) {
    return `http://127.0.0.1:${port}`
  }
  if (engine === Engine.Meilisearch) {
    return `http://127.0.0.1:${port}`
  }
  if (engine === Engine.CouchDB) {
    return `http://127.0.0.1:${port}/${database}`
  }
  if (engine === Engine.CockroachDB) {
    return `postgresql://root@127.0.0.1:${port}/${database}?sslmode=disable`
  }
  if (engine === Engine.SurrealDB) {
    return `ws://127.0.0.1:${port}/rpc`
  }
  if (engine === Engine.TypeDB) {
    return `typedb://127.0.0.1:${port}`
  }
  if (engine === Engine.InfluxDB) {
    return `http://127.0.0.1:${port}`
  }
  if (engine === Engine.Weaviate) {
    return `http://127.0.0.1:${port}`
  }
  if (engine === Engine.TigerBeetle) {
    return `127.0.0.1:${port}`
  }
  if (engine === Engine.LibSQL) {
    return `http://127.0.0.1:${port}`
  }
  return `postgresql://postgres@127.0.0.1:${port}/${database}`
}

// Qdrant 辅助函数

/**
 * 获取 Qdrant 中的集合数量
 */
export async function getQdrantCollectionCount(port: number): Promise<number> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/collections`)
    const data = (await response.json()) as {
      result?: { collections?: unknown[] }
    }
    return data.result?.collections?.length || 0
  } catch {
    return 0
  }
}

/**
 * 在 Qdrant 中创建一个集合
 */
export async function createQdrantCollection(
  port: number,
  name: string,
  vectorSize = 128,
): Promise<boolean> {
  try {
    const encodedName = encodeURIComponent(name)
    const response = await fetch(
      `http://127.0.0.1:${port}/collections/${encodedName}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vectors: {
            size: vectorSize,
            distance: 'Cosine',
          },
        }),
      },
    )
    return response.ok
  } catch {
    return false
  }
}

/**
 * 在 Qdrant 中删除一个集合
 */
export async function deleteQdrantCollection(
  port: number,
  name: string,
): Promise<boolean> {
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/collections/${name}`,
      {
        method: 'DELETE',
      },
    )
    return response.ok
  } catch {
    return false
  }
}

/**
 * 获取 Qdrant 集合中的点数
 */
export async function getQdrantPointCount(
  port: number,
  collection: string,
): Promise<number> {
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/collections/${collection}`,
    )
    const data = (await response.json()) as {
      result?: { points_count?: number }
    }
    return data.result?.points_count || 0
  } catch {
    return 0
  }
}

/**
 * 向 Qdrant 集合中插入点
 */
export async function insertQdrantPoints(
  port: number,
  collection: string,
  points: Array<{
    id: number
    vector: number[]
    payload?: Record<string, unknown>
  }>,
): Promise<boolean> {
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/collections/${collection}/points`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ points }),
      },
    )
    return response.ok
  } catch {
    return false
  }
}

/**
 * 获取引擎的最高可用版本。
 * 从 hostdb 或回退的版本映射中获取可用版本。
 */
export async function getAvailableVersion(engine: Engine): Promise<string> {
  const engineImpl = getEngine(engine)
  const versions = await engineImpl.fetchAvailableVersions()
  const availableVersions = Object.keys(versions)

  if (availableVersions.length === 0) {
    throw new Error(`未找到 ${engine} 的可用版本`)
  }

  // 返回最高的语义化版本
  return availableVersions.sort((a, b) => compareVersions(b, a))[0]
}

// 使用 engine.runScript 执行 SQL 文件（测试 run 命令的功能）
export async function runScriptFile(
  containerName: string,
  filePath: string,
  database?: string,
): Promise<void> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    throw new Error(`未找到容器 "${containerName}"`)
  }

  const engine = getEngine(config.engine)
  await engine.runScript(config, {
    file: filePath,
    database,
  })
}

// 使用 engine.runScript 执行内联 SQL（测试 run 命令的功能）
export async function runScriptSQL(
  containerName: string,
  sql: string,
  database?: string,
): Promise<void> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    throw new Error(`未找到容器 "${containerName}"`)
  }

  const engine = getEngine(config.engine)
  await engine.runScript(config, {
    sql,
    database,
  })
}

/**
 * 使用 engine.runScript 为 MongoDB 兼容引擎执行内联 JavaScript。
 * 这是 runScriptSQL 的别名 — MongoDB/FerretDB 使用 JavaScript 而非 SQL。
 * 单独命名是为了在测试文档数据库时更清晰。
 */
export async function runScriptJS(
  containerName: string,
  script: string,
  database?: string,
): Promise<void> {
  return runScriptSQL(containerName, script, database)
}

/**
 * 使用 engine.executeQuery 执行查询（测试 spindb query 命令）
 * 返回包含列、行和行数的 QueryResult
 */
export async function executeQuery(
  containerName: string,
  query: string,
  database?: string,
): Promise<QueryResult> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    throw new Error(`未找到容器 "${containerName}"`)
  }

  const engine = getEngine(config.engine)
  return engine.executeQuery(config, query, { database })
}

// Meilisearch 辅助函数

/**
 * 获取 Meilisearch 中的索引数量
 */
export async function getMeilisearchIndexCount(port: number): Promise<number> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/indexes`)
    const data = (await response.json()) as { results?: unknown[] }
    return data.results?.length || 0
  } catch {
    return 0
  }
}

/**
 * 在 Meilisearch 中创建一个索引
 */
export async function createMeilisearchIndex(
  port: number,
  uid: string,
  primaryKey = 'id',
): Promise<{ success: boolean; taskUid?: number }> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/indexes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uid,
        primaryKey,
      }),
    })
    // Meilisearch 对异步任务返回 202 Accepted
    if (response.status === 202 || response.ok) {
      const data = (await response.json()) as { taskUid?: number }
      return { success: true, taskUid: data.taskUid }
    }
    return { success: false }
  } catch {
    return { success: false }
  }
}

/**
 * 等待 Meilisearch 任务完成
 */
export async function waitForMeilisearchTask(
  port: number,
  taskUid: number,
  timeoutMs = 30000,
): Promise<boolean> {
  const startTime = Date.now()
  const checkInterval = 200

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/tasks/${taskUid}`)
      const task = (await response.json()) as { status?: string }
      if (task.status === 'succeeded') {
        return true
      }
      if (task.status === 'failed') {
        return false
      }
    } catch {
      // 忽略错误并继续等待
    }
    await new Promise((resolve) => setTimeout(resolve, checkInterval))
  }
  return false
}

/**
 * 在 Meilisearch 中删除一个索引
 */
export async function deleteMeilisearchIndex(
  port: number,
  uid: string,
): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/indexes/${uid}`, {
      method: 'DELETE',
    })
    return response.status === 202 || response.ok
  } catch {
    return false
  }
}

/**
 * 获取 Meilisearch 索引中的文档数量
 */
export async function getMeilisearchDocumentCount(
  port: number,
  indexUid: string,
): Promise<number> {
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/indexes/${indexUid}/stats`,
    )
    const data = (await response.json()) as { numberOfDocuments?: number }
    return data.numberOfDocuments || 0
  } catch {
    return 0
  }
}

/**
 * 向 Meilisearch 索引中插入文档
 */
export async function insertMeilisearchDocuments(
  port: number,
  indexUid: string,
  documents: Array<Record<string, unknown>>,
): Promise<{ success: boolean; taskUid?: number }> {
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/indexes/${indexUid}/documents`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(documents),
      },
    )
    if (response.status === 202 || response.ok) {
      const data = (await response.json()) as { taskUid?: number }
      return { success: true, taskUid: data.taskUid }
    }
    return { success: false }
  } catch {
    return { success: false }
  }
}

// CouchDB 辅助函数
// CouchDB 3.x 要求大多数操作进行管理员认证
const COUCHDB_AUTH_HEADER = `Basic ${Buffer.from('admin:admin').toString('base64')}`

/**
 * 获取 CouchDB 中的数据库数量（不包括系统数据库）
 */
export async function getCouchDBDatabaseCount(port: number): Promise<number> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/_all_dbs`, {
      headers: { Authorization: COUCHDB_AUTH_HEADER },
    })
    const data = (await response.json()) as string[]
    // 过滤掉系统数据库（以 _ 开头的）
    return data.filter((db) => !db.startsWith('_')).length
  } catch {
    return 0
  }
}

/**
 * 在 CouchDB 中创建一个数据库
 */
export async function createCouchDBDatabase(
  port: number,
  name: string,
): Promise<boolean> {
  try {
    const encodedName = encodeURIComponent(name)
    const response = await fetch(`http://127.0.0.1:${port}/${encodedName}`, {
      method: 'PUT',
      headers: { Authorization: COUCHDB_AUTH_HEADER },
    })
    // 201 = 已创建，412 = 已存在（两者都可接受）
    return response.status === 201 || response.status === 412
  } catch {
    return false
  }
}

/**
 * 在 CouchDB 中删除一个数据库
 */
export async function deleteCouchDBDatabase(
  port: number,
  name: string,
): Promise<boolean> {
  try {
    const encodedName = encodeURIComponent(name)
    const response = await fetch(`http://127.0.0.1:${port}/${encodedName}`, {
      method: 'DELETE',
      headers: { Authorization: COUCHDB_AUTH_HEADER },
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * 获取 CouchDB 数据库中的文档数量
 */
export async function getCouchDBDocumentCount(
  port: number,
  database: string,
): Promise<number> {
  try {
    const encodedDb = encodeURIComponent(database)
    const response = await fetch(`http://127.0.0.1:${port}/${encodedDb}`, {
      headers: { Authorization: COUCHDB_AUTH_HEADER },
    })
    const data = (await response.json()) as { doc_count?: number }
    return data.doc_count || 0
  } catch {
    return 0
  }
}

/**
 * 使用 _bulk_docs 向 CouchDB 数据库插入文档
 */
export async function insertCouchDBDocuments(
  port: number,
  database: string,
  documents: Array<Record<string, unknown>>,
): Promise<boolean> {
  try {
    const encodedDb = encodeURIComponent(database)
    const response = await fetch(
      `http://127.0.0.1:${port}/${encodedDb}/_bulk_docs`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: COUCHDB_AUTH_HEADER,
        },
        body: JSON.stringify({ docs: documents }),
      },
    )
    return response.status === 201
  } catch {
    return false
  }
}

/**
 * 从 CouchDB 数据库获取所有文档
 */
export async function getCouchDBDocuments(
  port: number,
  database: string,
): Promise<Array<Record<string, unknown>>> {
  try {
    const encodedDb = encodeURIComponent(database)
    const response = await fetch(
      `http://127.0.0.1:${port}/${encodedDb}/_all_docs?include_docs=true`,
      { headers: { Authorization: COUCHDB_AUTH_HEADER } },
    )
    const data = (await response.json()) as {
      rows?: Array<{ doc?: Record<string, unknown> }>
    }
    return (
      data.rows
        ?.map((row) => row.doc)
        .filter((doc): doc is Record<string, unknown> => doc !== undefined) ||
      []
    )
  } catch {
    return []
  }
}

// Weaviate 辅助函数

/**
 * 获取 Weaviate 中的类数量
 */
export async function getWeaviateClassCount(port: number): Promise<number> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/schema`)
    const data = (await response.json()) as { classes?: unknown[] }
    return data.classes?.length || 0
  } catch {
    return 0
  }
}

/**
 * 在 Weaviate 中创建一个类
 */
export async function createWeaviateClass(
  port: number,
  name: string,
  vectorizer = 'none',
): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/schema`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        class: name,
        vectorizer,
        properties: [
          {
            name: 'content',
            dataType: ['text'],
          },
        ],
      }),
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * 在 Weaviate 中删除一个类
 */
export async function deleteWeaviateClass(
  port: number,
  name: string,
): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/schema/${name}`, {
      method: 'DELETE',
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * 获取 Weaviate 类中的对象数量
 */
export async function getWeaviateObjectCount(
  port: number,
  className: string,
): Promise<number> {
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/v1/objects?class=${className}&limit=0`,
    )
    const data = (await response.json()) as { totalResults?: number }
    return data.totalResults || 0
  } catch {
    return 0
  }
}

/**
 * 向 Weaviate 类中插入对象
 */
export async function insertWeaviateObjects(
  port: number,
  className: string,
  objects: Array<{ properties: Record<string, unknown>; vector?: number[] }>,
): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/batch/objects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        objects: objects.map((obj) => ({
          class: className,
          properties: obj.properties,
          vector: obj.vector,
        })),
      }),
    })
    return response.ok
  } catch {
    return false
  }
}
