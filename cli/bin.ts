#!/usr/bin/env tsx

import { run } from './index'

// 启动应用并捕获未处理的错误
run().catch((err) => {
  console.error(err)
  console.error('')
  console.error('如果此错误持续出现，请尝试运行：spindb doctor --fix')
  process.exit(1)
})
