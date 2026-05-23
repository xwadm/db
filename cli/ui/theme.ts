import chalk from 'chalk'

// 主题定义
export const theme = {
  // 品牌颜色
  primary: chalk.cyan,
  secondary: chalk.gray,
  accent: chalk.magenta,

  // 状态颜色
  success: chalk.green,
  error: chalk.red,
  warning: chalk.yellow,
  info: chalk.blue,

  // 文字样式
  bold: chalk.bold,
  dim: chalk.dim,
  italic: chalk.italic,

  // 语义化助手
  containerName: chalk.cyan.bold,
  version: chalk.yellow,
  port: chalk.green,
  path: chalk.gray,
  command: chalk.cyan,

  // 状态徽章
  running: chalk.green.bold('● 运行中'),
  stopped: chalk.gray('○ 已停止'),
  created: chalk.blue('◐ 已创建'),

  // 图标
  icons: {
    success: chalk.green('✔'),
    error: chalk.red('✖'),
    warning: chalk.yellow('⚠'),
    info: chalk.blue('ℹ'),
    arrow: chalk.cyan('→'),
    bullet: chalk.gray('•'),
  },
}

// 生成标题
export function header(text: string): string {
  return `${chalk.bold(text)}\n${chalk.gray('─'.repeat(40))}`
}

// 成功消息
export function uiSuccess(message: string): string {
  return `${theme.icons.success} ${message}`
}

// 错误消息
export function uiError(message: string): string {
  return `${theme.icons.error} ${chalk.red(message)}`
}

// 警告消息
export function uiWarning(message: string): string {
  return `${theme.icons.warning} ${chalk.yellow(message)}`
}

// 信息消息
export function uiInfo(message: string): string {
  return `${theme.icons.info} ${message}`
}

// 键值对格式化
export function keyValue(key: string, value: string): string {
  return `${chalk.gray(key + ':')} ${value}`
}

// 去除 ANSI 转义码
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, '')
}

// 按宽度填充字符串
function padToWidth(str: string, width: number): string {
  const visibleLength = stripAnsi(str).length
  const padding = Math.max(0, width - visibleLength)
  return str + ' '.repeat(padding)
}

// 创建框形输出
export function box(lines: string[], padding: number = 2): string {
  // 计算最大可见宽度
  const maxWidth = Math.max(...lines.map((line) => stripAnsi(line).length))
  const innerWidth = maxWidth + padding * 2
  const horizontalLine = '─'.repeat(innerWidth)

  const boxLines = [chalk.cyan('┌' + horizontalLine + '┐')]

  for (const line of lines) {
    const paddedLine = padToWidth(line, maxWidth)
    boxLines.push(
      chalk.cyan('│') +
        ' '.repeat(padding) +
        paddedLine +
        ' '.repeat(padding) +
        chalk.cyan('│'),
    )
  }

  boxLines.push(chalk.cyan('└' + horizontalLine + '┘'))

  return boxLines.join('\n')
}

// 连接信息框
export function connectionBox(
  name: string,
  connectionString: string,
  port: number,
): string {
  const lines = [
    `${theme.icons.success} 容器 ${chalk.bold(name)} 已就绪！`,
    '',
    chalk.gray('连接字符串：'),
    chalk.white(connectionString),
    '',
    `${chalk.gray('端口：')} ${chalk.green(String(port))}`,
  ]

  return box(lines)
}

// 格式化字节大小
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.max(
    0,
    Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1),
  )
  const value = bytes / Math.pow(1024, i)
  return `${value.toFixed(1)} ${units[i]}`
}
