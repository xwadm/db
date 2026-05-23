import { Command } from 'commander'
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { containerManager } from '../../core/container-manager'
import { paths } from '../../config/paths'
import { promptContainerSelect } from '../ui/prompts'
import { uiError, uiWarning, uiInfo } from '../ui/theme'
import { isRemoteContainer } from '../../types'
import { followFile, getLastNLines } from '../utils/file-follower'

export const logsCommand = new Command('logs')
  .description('查看容器日志')
  .argument('[name]', '容器名称')
  .option('-f, --follow', '跟踪日志输出（类似 tail -f）')
  .option('-n, --lines <number>', '显示的行数', '50')
  .option('--editor', '在 $EDITOR 中打开日志')
  .action(
    async (
      name: string | undefined,
      options: { follow?: boolean; lines?: string; editor?: boolean },
    ) => {
      try {
        let containerName = name

        if (!containerName) {
          const containers = await containerManager.list()

          if (containers.length === 0) {
            console.log(uiWarning('未找到容器'))
            return
          }

          const selected = await promptContainerSelect(
            containers,
            '选择容器：',
          )
          if (!selected) return
          containerName = selected
        }

        const config = await containerManager.getConfig(containerName)
        if (!config) {
          console.error(uiError(`未找到容器 "${containerName}"`))
          process.exit(1)
        }

        // 远程容器没有本地日志
        if (isRemoteContainer(config)) {
          console.log(
            uiInfo('链接的远程容器没有可用的本地日志。'),
          )
          return
        }

        const logPath = paths.getContainerLogPath(config.name, {
          engine: config.engine,
        })

        if (!existsSync(logPath)) {
          console.log(
            uiInfo(
              `未找到 "${containerName}" 的日志文件。容器可能尚未启动。`,
            ),
          )
          return
        }

        if (options.editor) {
          const editorCmd = process.env.EDITOR || 'vi'
          const child = spawn(editorCmd, [logPath], {
            stdio: 'inherit',
          })

          await new Promise<void>((resolve, reject) => {
            child.on('close', (code) => {
              if (code === 0) {
                resolve()
              } else {
                reject(new Error(`编辑器以代码 ${code} 退出`))
              }
            })
            child.on('error', reject)
          })
          return
        }

        if (options.follow) {
          const lineCount = parseInt(options.lines || '50', 10)
          // 使用跨平台文件跟踪（适用于 Windows、macOS、Linux）
          await followFile(logPath, lineCount)
          return
        }

        const lineCount = parseInt(options.lines || '50', 10)
        const content = await readFile(logPath, 'utf-8')

        if (content.trim() === '') {
          console.log(uiInfo('日志文件为空'))
          return
        }

        const output = getLastNLines(content, lineCount)
        console.log(output)
      } catch (error) {
        const e = error as Error
        console.error(uiError(e.message))
        process.exit(1)
      }
    },
  )
