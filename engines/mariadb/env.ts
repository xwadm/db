/**
 * 构建 MariaDB 进程环境变量
 *
 * 通过 MYSQL_PWD 环境变量传递密码，避免在进程参数列表中暴露。
 * 如果未提供密码，则从环境中移除 MYSQL_PWD。
 *
 * @param password - 可选的数据库密码
 * @returns 包含 MYSQL_PWD 的环境变量对象
 */
export function buildMariaDbEnv(password?: string): NodeJS.ProcessEnv {
  const env = { ...process.env }
  if (password !== undefined) {
    env.MYSQL_PWD = password
  } else {
    delete env.MYSQL_PWD
  }
  return env
}
