import chalk from 'chalk'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { spawn } from 'child_process'
import { containerManager } from '../../../core/container-manager'
import { getMissingDependencies } from '../../../core/dependency-manager'
import { getEngine } from '../../../engines'
import { Engine } from '../../../types'
import { paths } from '../../../config/paths'
import { promptInstallDependencies, escapeablePrompt } from '../../ui/prompts'
import { uiError, uiWarning, uiInfo, uiSuccess } from '../../ui/theme'
import { pressEnterToContinue } from './shared'
import { followFile, getLastNLines } from '../../utils/file-follower'
import { getEngineConfig } from '../../../config/engines-registry'

export async function handleRunSql(
  containerName: string,
  database?: string,
): Promise<void> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.error(uiError(`容器 "${containerName}" 未找到`))
    return
  }

  const engine = getEngine(config.engine)

  let missingDeps = await getMissingDependencies(config.engine)
  if (missingDeps.length > 0) {
    console.log(
      uiWarning(`缺少工具：${missingDeps.map((d) => d.name).join(', ')}`),
    )

    const installed = await promptInstallDependencies(
      missingDeps[0].binary,
      config.engine,
    )

    if (!installed) {
      return
    }

    missingDeps = await getMissingDependencies(config.engine)
    if (missingDeps.length > 0) {
      console.log(
        uiError(`仍然缺少工具：${missingDeps.map((d) => d.name).join(', ')}`),
      )
      return
    }

    console.log(chalk.green('  ✓ 所有必需工具现已可用'))
    console.log()
  }

  // 去除拖拽文件时终端自动添加的引号
  const stripQuotes = (path: string) => path.replace(/^['"]|['"]$/g, '').trim()

  // 脚本类型术语源自 engines.json 中的 scriptFileLabel
  // 例如 "Run SQL file" → type: "SQL", "Run TypeQL file" → type: "TypeQL"
  const engineConfig = await getEngineConfig(config.engine)
  const scriptType = (engineConfig.scriptFileLabel ?? 'Script file')
    .replace(/^Run\s+/, '')
    .replace(/\s+file$/, '')

  // 提示输入文件路径（空输入 = 返回）
  console.log(
    chalk.gray(
      '  拖放文件、输入路径（绝对或相对），或按回车键返回（esc - 主菜单）',
    ),
  )
  const { filePath: rawFilePath } = await escapeablePrompt<{
    filePath: string
  }>([
    {
      type: 'input',
      name: 'filePath',
      message: `${scriptType} 文件路径：`,
      validate: (input: string) => {
        if (!input) return true // 空输入 = 返回
        const cleanPath = stripQuotes(input)
        if (!existsSync(cleanPath)) return '文件未找到'
        return true
      },
    },
  ])

  if (!rawFilePath.trim()) {
    return
  }

  const filePath = stripQuotes(rawFilePath)

  // 使用提供的数据库名或回退到容器默认值
  let databaseName = database || config.database

  // InfluxDB：发现真实数据库（写入时隐式创建）
  // 此处不能使用 engine.listDatabases()，因为当列表为空时会回退到
  // container.database，从而隐藏我们需要检测的“无数据库”状态以便发出 .lp 警告。
  if (config.engine === Engine.InfluxDB) {
    try {
      const resp = await fetch(
        `http://127.0.0.1:${config.port}/api/v3/configure/database?format=json`,
      )
      if (resp.ok) {
        const databases = (await resp.json()) as Array<Record<string, string>>
        const dbNames = databases
          .map((d) => d['iox::database'] || d.name)
          .filter((n) => n && n !== '_internal')
        if (dbNames.length === 0 && !filePath.endsWith('.lp')) {
          console.log(
            uiWarning('尚不存在任何数据库。请先使用 .lp 文件填充数据。'),
          )
          await pressEnterToContinue()
          return
        }
        if (!dbNames.includes(databaseName)) {
          if (dbNames.length === 1) {
            databaseName = dbNames[0]
          } else if (dbNames.length > 1) {
            const { chosenDb } = await escapeablePrompt<{ chosenDb: string }>([
              {
                type: 'list',
                name: 'chosenDb',
                message: '选择数据库：',
                choices: dbNames,
              },
            ])
            databaseName = chosenDb
          }
        }
      }
    } catch {
      // 使用默认值继续
    }
  }

  console.log()
  console.log(uiInfo(`正在对 "${databaseName}" 执行 ${scriptType} 文件...`))
  console.log()

  try {
    await engine.runScript(config, {
      file: filePath,
      database: databaseName,
    })
    console.log()
    console.log(uiSuccess(`${scriptType} 文件执行成功`))
  } catch (error) {
    const e = error as Error
    console.log()
    console.log(uiError(`${scriptType} 执行失败：${e.message}`))
  }

  console.log()
  await pressEnterToContinue()
}

// 通过交互式选项查看容器日志
export async function handleViewLogs(containerName: string): Promise<void> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.error(uiError(`容器 "${containerName}" 未找到`))
    return
  }

  const logPath = paths.getContainerLogPath(config.name, {
    engine: config.engine,
  })

  if (!existsSync(logPath)) {
    console.log(
      uiInfo(`未找到 "${containerName}" 的日志文件。该容器可能尚未启动。`),
    )
    await pressEnterToContinue()
    return
  }

  const { action } = await escapeablePrompt<{ action: string }>([
    {
      type: 'list',
      name: 'action',
      message: '您希望如何查看日志？',
      choices: [
        { name: '查看最近 50 行', value: 'tail-50' },
        { name: '查看最近 100 行', value: 'tail-100' },
        { name: '实时跟踪日志', value: 'follow' },
        { name: '在编辑器中打开', value: 'editor' },
        { name: `${chalk.blue('←')} 返回`, value: 'back' },
      ],
    },
  ])

  if (action === 'back') {
    return
  }

  if (action === 'editor') {
    const editorCmd = process.env.EDITOR || 'vi'
    const child = spawn(editorCmd, [logPath], { stdio: 'inherit' })
    await new Promise<void>((resolve) => {
      child.on('close', () => resolve())
    })
    return
  }

  if (action === 'follow') {
    console.log(chalk.gray('  按 Ctrl+C 停止跟踪日志'))
    console.log()
    // 使用跨平台文件跟踪（适用于 Windows、macOS、Linux）
    await followFile(logPath, 50)
    return
  }

  // 查看最近 50 行或 100 行
  const lineCount = action === 'tail-100' ? 100 : 50
  const content = await readFile(logPath, 'utf-8')
  if (content.trim() === '') {
    console.log(uiInfo('日志文件为空'))
  } else {
    console.log(getLastNLines(content, lineCount))
  }
  console.log()
  await pressEnterToContinue()
}
