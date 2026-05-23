import chalk from 'chalk'
import type inquirer from 'inquirer'
import { escapeablePrompt } from '../../ui/prompts'

// inquirer 列表提示的菜单选项类型
export type MenuChoice =
  | {
      name: string
      value: string
      disabled?: boolean | string
    }
  | inquirer.Separator

// 辅助函数：暂停并等待用户按下 Enter 键
export async function pressEnterToContinue(): Promise<void> {
  await escapeablePrompt([
    {
      type: 'input',
      name: 'continue',
      message: chalk.gray('按 Enter 键继续...'),
    },
  ])
}
