#!/usr/bin/env node
/**
 * 将 `hostdb` 依赖从 `file:../hostdb`（开发链接）切换为精确的
 * npm 固定版本（`0.31.0`）。在 hostdb 已经发布到 npm 之后、
 * 合并 spindb 到 dev/main 之前运行。
 *
 * 用法：
 *   node scripts/flip-hostdb-pin.mjs              # 自动检测目标版本
 *   node scripts/flip-hostdb-pin.mjs 0.31.0       # 明确指定版本
 *
 * 脚本功能：
 *   1. 读取 `../hostdb/package.json` 来确定目标版本（或使用
 *      命令行参数指定的版本）。
 *   2. 验证该版本确实已发布到 npm（否则拒绝切换 ——
 *      避免产生一个损坏的合并）。
 *   3. 更新 `spindb/package.json` 中 dependencies.hostdb 为精确版本。
 *   4. 运行 `pnpm install` 以重新生成 pnpm-lock.yaml，
 *      使其指向 npm 托管的 hostdb（不再使用本地 file: 路径）。
 *   5. 运行完整的测试套件，验证行为与本地开发树一致。
 *
 * 遇到任何失败则以非零状态码退出；合并不应继续进行。
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const HOSTDB_PKG = join(ROOT, '..', 'hostdb', 'package.json')

function exec(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    stdio: 'inherit',
    cwd: ROOT,
    ...opts,
  })
}

function execCapture(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: 'utf-8',
    cwd: ROOT,
    ...opts,
  }).trim()
}

const targetVersionArg = process.argv[2]
let targetVersion = targetVersionArg

if (!targetVersion) {
  try {
    const hostdbPkg = JSON.parse(readFileSync(HOSTDB_PKG, 'utf-8'))
    targetVersion = hostdbPkg.version
    console.log(`从 ${HOSTDB_PKG} 自动检测到目标版本：${targetVersion}`)
  } catch (err) {
    console.error(
      `无法自动检测 hostdb 版本（不存在 ../hostdb 同级目录？）。` +
        `请显式传入版本：node scripts/flip-hostdb-pin.mjs 0.31.0`,
    )
    console.error(`底层错误：${err.message}`)
    process.exit(1)
  }
}

if (!/^\d+\.\d+\.\d+$/.test(targetVersion)) {
  console.error(
    `目标版本必须是精确的语义化版本（例如 0.31.0）。实际得到：${targetVersion}`,
  )
  process.exit(2)
}

console.log(`\n正在验证 hostdb@${targetVersion} 是否存在于 npm...`)
try {
  const published = execCapture('npm', [
    'view',
    `hostdb@${targetVersion}`,
    'version',
  ])
  if (published !== targetVersion) {
    throw new Error(`npm 返回了 ${published}，而不是 ${targetVersion}`)
  }
  console.log(`  ✓ hostdb@${targetVersion} 已发布到 npm`)
} catch (err) {
  console.error(
    `\n✗ hostdb@${targetVersion} 尚未在 npm 上发布。发布工作流需要先完成。`,
  )
  console.error(`  检查：gh workflow view publish.yml（在 ~/dev/hostdb 中）`)
  console.error(`  或者：npm view hostdb version  （应返回 ${targetVersion}）`)
  console.error(`\n底层错误：${err.message}`)
  process.exit(3)
}

console.log(
  `\n正在更新 package.json：hostdb -> ${targetVersion}（精确固定）...`,
)
const pkgPath = join(ROOT, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
const previous = pkg.dependencies.hostdb
if (previous === targetVersion) {
  console.log(`  hostdb 已固定为 ${targetVersion}`)
} else {
  pkg.dependencies.hostdb = targetVersion
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
  console.log(`  ${previous} -> ${targetVersion}`)
}

// 总是运行 install，以处理 package.json 已经固定但
// pnpm-lock.yaml 仍指向 file:../hostdb 的情况（脚本被中断，
// 或者某人在部分切换后运行了 `pnpm install`）。
console.log(`\n正在重新生成 pnpm-lock.yaml...`)
exec('pnpm', ['install'])

console.log(`\n正在运行完整测试套件...`)
exec('pnpm', ['lint'])
exec('pnpm', ['test:unit'])
exec('pnpm', ['test:hostdb-sync'])
exec('pnpm', ['test:cli'])

console.log(`\n✓ 完成。检查 diff，然后：`)
console.log(
  `  git add package.json pnpm-lock.yaml && git commit -m "chore(deps): pin hostdb ${targetVersion}"`,
)
console.log(`  git push`)
console.log(
  `\n现在可以安全地合并 upgrade/spindb-hostdb-integration -> dev -> main。`,
)
