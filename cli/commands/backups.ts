/**
 * 列出备份文件命令
 *
 * 扫描当前目录（或指定目录）中的备份文件，并显示其元数据。
 */

import { Command } from 'commander'
import { readdirSync, statSync } from 'fs'
import { join, extname } from 'path'
import { homedir } from 'os'
import chalk from 'chalk'
import { formatBytes } from '../ui/theme'
import { getEngineIcon } from '../constants'

type BackupInfo = {
  filename: string
  path: string
  size: number
  modified: Date
  engine: string | null
  format: string
}

// 根据文件扩展名检测数据库引擎和备份格式
function detectBackupType(filename: string): {
  engine: string | null
  format: string
} {
  const ext = extname(filename).toLowerCase()

  // 检测双扩展名，如 .sql.gz
  if (filename.endsWith('.sql.gz')) {
    return { engine: 'mysql', format: '压缩 SQL' }
  }

  switch (ext) {
    case '.sql':
      // 可能是 PostgreSQL、MySQL 或 SQLite
      return { engine: null, format: 'SQL 转储' }
    case '.dump':
      return { engine: 'postgresql', format: 'pg_dump 自定义格式' }
    case '.sqlite':
    case '.db':
    case '.sqlite3':
      return { engine: 'sqlite', format: '二进制复制' }
    case '.duckdb':
    case '.ddb':
      return { engine: 'duckdb', format: '二进制复制' }
    case '.archive':
      return { engine: 'mongodb', format: 'BSON 归档' }
    case '.rdb':
      return { engine: 'redis', format: 'RDB 快照' }
    case '.redis':
      return { engine: 'redis', format: '文本命令' }
    case '.bson':
      return { engine: 'mongodb', format: 'BSON' }
    default:
      return { engine: null, format: '未知' }
  }
}

// 判断文件是否看起来像备份文件
function isBackupFile(filename: string): boolean {
  const backupExtensions = [
    '.sql',
    '.dump',
    '.sqlite',
    '.sqlite3',
    '.db',
    '.duckdb',
    '.ddb',
    '.archive',
    '.rdb',
    '.redis',
    '.bson',
  ]

  // 检测 .sql.gz
  if (filename.endsWith('.sql.gz')) return true

  const ext = extname(filename).toLowerCase()
  return backupExtensions.includes(ext)
}

// 扫描目录中的备份文件
function findBackups(directory: string): BackupInfo[] {
  const backups: BackupInfo[] = []

  try {
    const files = readdirSync(directory)

    for (const file of files) {
      if (!isBackupFile(file)) continue

      const filePath = join(directory, file)
      try {
        const stats = statSync(filePath)
        if (!stats.isFile()) continue

        const { engine, format } = detectBackupType(file)

        backups.push({
          filename: file,
          path: filePath,
          size: stats.size,
          modified: stats.mtime,
          engine,
          format,
        })
      } catch {
        // 跳过无法获取状态的文件
      }
    }
  } catch {
    // 目录不存在或无法读取
  }

  // 按修改日期排序，最新的在前
  backups.sort((a, b) => b.modified.getTime() - a.modified.getTime())

  return backups
}

// 格式化相对时间字符串
function formatRelativeTime(date: Date): string {
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return '刚刚'
  if (diffMins < 60) return `${diffMins}分钟前`
  if (diffHours < 24) return `${diffHours}小时前`
  if (diffDays < 7) return `${diffDays}天前`

  return date.toLocaleDateString()
}

// 获取引擎图标 - 包装共享函数，对未知引擎提供回退图标
function getBackupEngineIcon(engine: string | null): string {
  if (!engine) return '📦 '
  return getEngineIcon(engine)
}

export const backupsCommand = new Command('backups')
  .description('列出当前目录中的备份文件')
  .argument('[directory]', '要扫描的目录（默认为当前目录）')
  .option('-a, --all', '同时包含 ~/.spindb/backups 中的备份')
  .option('-n, --limit <count>', '限制结果数量', '20')
  .option('-j, --json', '以 JSON 格式输出')
  .action(
    async (
      directory: string | undefined,
      options: {
        all?: boolean
        limit?: string
        json?: boolean
      },
    ) => {
      const searchDirs = [directory || process.cwd()]

      if (options.all) {
        const homeBackups = join(homedir(), '.spindb', 'backups')
        searchDirs.push(homeBackups)
      }

      const allBackups: BackupInfo[] = []

      for (const dir of searchDirs) {
        const backups = findBackups(dir)
        allBackups.push(...backups)
      }

      // 按日期排序所有备份
      allBackups.sort((a, b) => b.modified.getTime() - a.modified.getTime())

      // 应用数量限制
      const limit = parseInt(options.limit || '20', 10)
      const limitedBackups = allBackups.slice(0, limit)

      if (options.json) {
        console.log(
          JSON.stringify(
            limitedBackups.map((b) => ({
              filename: b.filename,
              path: b.path,
              size: b.size,
              modified: b.modified.toISOString(),
              engine: b.engine,
              format: b.format,
            })),
            null,
            2,
          ),
        )
        return
      }

      if (limitedBackups.length === 0) {
        console.log()
        console.log(chalk.gray('  未找到备份文件'))
        console.log()
        console.log(chalk.gray('  备份文件通过以下扩展名识别：'))
        console.log(
          chalk.gray('    .sql, .dump, .sqlite, .archive, .rdb, .sql.gz'),
        )
        console.log()
        return
      }

      console.log()
      console.log(chalk.bold(`  找到 ${allBackups.length} 个备份`))
      if (allBackups.length > limit) {
        console.log(chalk.gray(`  （显示最近的 ${limit} 个）`))
      }
      console.log()

      // 计算列宽
      const maxFilename = Math.min(
        50,
        Math.max(...limitedBackups.map((b) => b.filename.length)),
      )

      for (const backup of limitedBackups) {
        const icon = getBackupEngineIcon(backup.engine)
        const filename =
          backup.filename.length > maxFilename
            ? backup.filename.slice(0, maxFilename - 3) + '...'
            : backup.filename.padEnd(maxFilename)

        const size = formatBytes(backup.size).padStart(10)
        const time = formatRelativeTime(backup.modified).padStart(10)
        const format = chalk.gray(backup.format)

        console.log(
          `  ${icon} ${chalk.cyan(filename)} ${chalk.white(size)} ${chalk.gray(time)} ${format}`,
        )
      }

      console.log()
      console.log(chalk.gray('  使用以下命令还原：'))
      console.log(chalk.cyan('    spindb restore <container> <backup-file>'))
      console.log()
    },
  )
