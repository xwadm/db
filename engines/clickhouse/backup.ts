/**
 * ClickHouse 备份模块
 * 支持使用 clickhouse 客户端进行基于 SQL 的备份
 *
 * ClickHouse 备份格式：
 * - SQL：DDL + INSERT 语句（可移植，人类可读）
 * - Native：ClickHouse 原生格式（速度更快，更紧凑）
 */

import { spawn } from 'child_process'
import { stat, mkdir, writeFile } from 'fs/promises'
import { existsSync, createWriteStream } from 'fs'
import { dirname } from 'path'
import {
  getDefaultUsername,
  loadCredentials,
} from '../../core/credential-manager'
import { logDebug, logWarning } from '../../core/error-handler'
import {
  requireClickHousePath,
  validateClickHouseIdentifier,
  escapeClickHouseIdentifier,
} from './cli-utils'
import {
  Engine,
  type ContainerConfig,
  type BackupOptions,
  type BackupResult,
} from '../../types'

type ClickHouseLocalAuth = {
  user?: string
  password?: string
}

function buildClickHouseEnv(auth?: ClickHouseLocalAuth): NodeJS.ProcessEnv {
  const env = { ...process.env }
  if (auth?.user) {
    env.CLICKHOUSE_USER = auth.user
  } else {
    delete env.CLICKHOUSE_USER
  }
  if (auth?.password) {
    env.CLICKHOUSE_PASSWORD = auth.password
  } else {
    delete env.CLICKHOUSE_PASSWORD
  }
  return env
}

async function loadLocalClickHouseAuth(
  container: ContainerConfig,
): Promise<ClickHouseLocalAuth> {
  const savedCreds = await loadCredentials(
    container.name,
    Engine.ClickHouse,
    getDefaultUsername(Engine.ClickHouse),
  )

  if (!savedCreds) {
    return {}
  }

  return {
    user: savedCreds.username,
    password: savedCreds.password,
  }
}

/**
 * 执行 ClickHouse 查询并返回结果
 */
async function execClickHouseQuery(
  clickhousePath: string,
  port: number,
  database: string,
  query: string,
  auth?: ClickHouseLocalAuth,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      'client',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--database',
      database,
      '--query',
      query,
    ]

    const proc = spawn(clickhousePath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildClickHouseEnv(auth),
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('error', reject)

    proc.on('close', (code) => {
      if (code === 0 || code === null) {
        resolve(stdout)
      } else {
        reject(new Error(stderr || `clickhouse 客户端退出，错误码 ${code}`))
      }
    })
  })
}

/**
 * 获取数据库中的所有表
 */
async function getTables(
  clickhousePath: string,
  port: number,
  database: string,
  auth?: ClickHouseLocalAuth,
): Promise<string[]> {
  // 验证数据库标识符以防止 SQL 注入
  validateClickHouseIdentifier(database, 'database')
  // 转义单引号以用于字符串字面量（WHERE 子句）
  const escapedDbLiteral = database.replace(/'/g, "''")

  const result = await execClickHouseQuery(
    clickhousePath,
    port,
    database,
    `SELECT name FROM system.tables WHERE database = '${escapedDbLiteral}' ORDER BY name`,
    auth,
  )
  return result
    .trim()
    .split('\n')
    .filter((t) => t.trim())
}

/**
 * 获取表的 CREATE TABLE 语句
 * 返回不包含数据库前缀的可移植 SQL，以便跨数据库还原
 */
async function getCreateTableStatement(
  clickhousePath: string,
  port: number,
  database: string,
  table: string,
  auth?: ClickHouseLocalAuth,
): Promise<string> {
  // 验证并转义标识符以防止 SQL 注入
  validateClickHouseIdentifier(database, 'database')
  validateClickHouseIdentifier(table, 'table')
  const escapedDb = escapeClickHouseIdentifier(database)
  const escapedTable = escapeClickHouseIdentifier(table)

  // 使用 TSVRaw 格式获取未转义的输出（换行符为实际换行，而非 \n）
  const result = await execClickHouseQuery(
    clickhousePath,
    port,
    database,
    `SHOW CREATE TABLE ${escapedDb}.${escapedTable} FORMAT TSVRaw`,
    auth,
  )

  // 从 CREATE TABLE 语句中剥离数据库前缀，使其可移植
  // 例如："CREATE TABLE testdb.test_user" → "CREATE TABLE test_user"
  // 例如："CREATE TABLE `testdb`.`test_user`" → "CREATE TABLE `test_user`"
  // 这样备份可以还原到任意目标数据库
  const createStmt = result.trim()
  // 转义数据库名中的正则表达式元字符，以便安全插值
  const escapedDatabase = database.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // 匹配带引号和不带引号的数据库名：db.table 或 `db`.table 或 `db`.`table`
  const dbPrefixPattern = new RegExp(
    `(CREATE TABLE\\s+)\`?${escapedDatabase}\`?\\.`,
    'i',
  )
  return createStmt.replace(dbPrefixPattern, '$1')
}

/**
 * 创建 SQL 备份（DDL + INSERT 语句）
 */
async function createSqlBackup(
  container: ContainerConfig,
  outputPath: string,
  database: string,
): Promise<BackupResult> {
  const { port, version } = container

  const clickhousePath = await requireClickHousePath(version)
  const auth = await loadLocalClickHouseAuth(container)

  const lines: string[] = []
  lines.push('-- SpinDB 生成的 ClickHouse 备份')
  lines.push(`-- 日期：${new Date().toISOString()}`)
  lines.push(`-- 数据库：${database}`)
  lines.push('')

  // 获取表列表
  const tables = await getTables(clickhousePath, port, database, auth)
  logDebug(`找到 ${tables.length} 个要备份的表`)

  for (const table of tables) {
    lines.push(`-- 表：${table}`)
    lines.push('')

    // 获取 CREATE TABLE 语句
    try {
      const createStmt = await getCreateTableStatement(
        clickhousePath,
        port,
        database,
        table,
        auth,
      )
      lines.push(createStmt + ';')
      lines.push('')
    } catch (error) {
      logWarning(`无法获取表 ${table} 的 CREATE TABLE 语句：${error}`)
      continue
    }

    // 使用 INSERT 格式导出数据
    try {
      // 验证并转义标识符以防止 SQL 注入
      // 注意：来自 getTables 的表名已验证，但为查询安全仍需转义
      validateClickHouseIdentifier(table, 'table')
      const escapedDb = escapeClickHouseIdentifier(database)
      const escapedTable = escapeClickHouseIdentifier(table)

      const data = await execClickHouseQuery(
        clickhousePath,
        port,
        database,
        `SELECT * FROM ${escapedDb}.${escapedTable} FORMAT SQLInsert`,
        auth,
      )
      if (data.trim()) {
        // SQLInsert 格式使用 "table" 作为占位符，需要将所有出现的 "table" 替换为实际表名
        // 使用全局标志以处理多语句输出
        const insertData = data
          .trim()
          .replace(/INSERT INTO table \(/gi, `INSERT INTO ${escapedTable} (`)
        lines.push(insertData)
        lines.push('')
      }
    } catch (error) {
      logWarning(`无法导出表 ${table} 的数据：${error}`)
    }
  }

  // 确保输出目录存在
  const outputDir = dirname(outputPath)
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true })
  }

  // 写入文件
  const content = lines.join('\n')
  await writeFile(outputPath, content, 'utf-8')

  const stats = await stat(outputPath)

  return {
    path: outputPath,
    format: 'sql',
    size: stats.size,
  }
}

/**
 * 创建原生格式备份（速度更快，更紧凑）
 *
 * TODO：待还原支持实现后启用原生备份格式。
 * Native 格式比 SQL 快约 10 倍且更紧凑，但还原时需要解析二进制格式。
 * 目前优先使用 SQL 格式，以保证可移植性，并方便通过 clickhouse 客户端的 --multiquery 进行还原。
 *
 * 架构说明：当前实现将文本标记（-- TABLE:、-- CREATE:、-- DATA:）与二进制 Native 格式数据混合
 * 在同一个流中。在启用此功能之前，需要重构为使用结构化容器格式，以便在还原时进行确定性解析：
 * - 采用 tar 归档，每个表单独文件（schema.sql + data.native）
 * - 或使用带长度前缀的二进制段
 * - 或在纯二进制数据旁边附加一个元数据 JSON 文件
 *
 * 启用方式：导出此函数，在 config/backup-formats.ts 中将 'native' 添加到 BACKUP_FORMATS，
 * 并在 restore.ts 中实现原生还原。
 *
 * @internal 保留以备将来原生备份支持
 */
async function _createNativeBackup(
  container: ContainerConfig,
  outputPath: string,
  database: string,
): Promise<BackupResult> {
  const { port, version } = container

  const clickhousePath = await requireClickHousePath(version)
  const auth = await loadLocalClickHouseAuth(container)

  // 确保输出目录存在
  const outputDir = dirname(outputPath)
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true })
  }

  // 获取表列表
  const tables = await getTables(clickhousePath, port, database, auth)
  logDebug(`找到 ${tables.length} 个要备份的表`)

  // 创建包含所有表的组合备份
  const fileStream = createWriteStream(outputPath)

  // 写入文件头
  const header = `-- ClickHouse 原生备份\n-- 数据库：${database}\n-- 日期：${new Date().toISOString()}\n\n`
  fileStream.write(header)

  for (const table of tables) {
    // 写入表标记
    fileStream.write(`\n-- 表：${table}\n`)

    // 获取 CREATE TABLE 语句
    try {
      const createStmt = await getCreateTableStatement(
        clickhousePath,
        port,
        database,
        table,
        auth,
      )
      fileStream.write(`-- CREATE:\n${createStmt};\n`)
    } catch (error) {
      logWarning(`无法获取表 ${table} 的 CREATE TABLE 语句：${error}`)
      continue
    }

    // 以 Native 格式导出数据（二进制，速度快）
    fileStream.write(`-- DATA（Native 格式）：\n`)

    // 验证并转义标识符以防止 SQL 注入
    validateClickHouseIdentifier(table, 'table')
    const escapedDb = escapeClickHouseIdentifier(database)
    const escapedTable = escapeClickHouseIdentifier(table)

    await new Promise<void>((resolve, reject) => {
      const args = [
        'client',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--database',
        database,
        '--query',
        `SELECT * FROM ${escapedDb}.${escapedTable} FORMAT Native`,
      ]

      const proc = spawn(clickhousePath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: buildClickHouseEnv(auth),
      })

      let stderr = ''

      proc.stdout.pipe(fileStream, { end: false })

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('error', reject)

      proc.on('close', (code) => {
        if (code === 0 || code === null) {
          resolve()
        } else {
          reject(new Error(stderr || `clickhouse 客户端退出，错误码 ${code}`))
        }
      })
    })

    fileStream.write('\n-- 表结束\n')
  }

  // 关闭文件
  await new Promise<void>((resolve, reject) => {
    fileStream.end((err: Error | null) => {
      if (err) reject(err)
      else resolve()
    })
  })

  const stats = await stat(outputPath)

  return {
    path: outputPath,
    format: 'native',
    size: stats.size,
  }
}

/**
 * 创建备份
 *
 * 目前仅支持 SQL 格式（DDL + INSERT 语句）。
 * Native 格式支持已计划但尚未实现还原功能。
 * 参见 _createNativeBackup 了解未来的原生实现。
 *
 * @param container - 容器配置
 * @param outputPath - 写入备份文件的路径
 * @param options - 备份选项（BackupOptions 类型）
 * @param options.format - 保留以备将来使用。目前忽略；所有备份均使用 SQL 格式。
 *   当添加原生格式支持后，'dump' 将使用 _createNativeBackup 以获得更快、更紧凑的备份。
 */
export async function createBackup(
  container: ContainerConfig,
  outputPath: string,
  options: BackupOptions,
): Promise<BackupResult> {
  const database = options.database || container.database || 'default'

  // 记录请求了非 SQL 格式但尚未支持的情况
  if (options.format && options.format !== 'sql') {
    logDebug(
      `ClickHouse 备份：请求了格式 '${options.format}'，但尚未支持。` +
        `将改用 SQL 格式。有关未来的原生支持，请参见 _createNativeBackup。`,
    )
  }

  // 目前仅支持 SQL 格式
  // 原生格式（_createNativeBackup）将在添加还原支持后启用
  return createSqlBackup(container, outputPath, database)
}

/**
 * 为克隆操作创建备份
 * 使用 SQL 格式以保证可靠性
 */
export async function createCloneBackup(
  container: ContainerConfig,
  outputPath: string,
): Promise<BackupResult> {
  return createSqlBackup(container, outputPath, container.database || 'default')
}
