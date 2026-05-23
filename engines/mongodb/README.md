# MongoDB 引擎实现

## 概述

MongoDB 是一个基于 JavaScript 查询的文档数据库。SpinDB 从 hostdb 下载 MongoDB 二进制文件，并通过 `mongod` 服务器和 `mongosh` shell 进行管理。

## 平台支持

| 平台 | 架构 | 状态 | 备注 |
|------|------|------|------|
| darwin | x64 | 支持 | 使用 hostdb 二进制文件 |
| darwin | arm64 | 支持 | 使用 hostdb 二进制文件（Apple Silicon） |
| linux | x64 | 支持 | 使用 hostdb 二进制文件 |
| linux | arm64 | 支持 | 使用 hostdb 二进制文件 |
| win32 | x64 | 支持 | 使用 hostdb 二进制文件 |

## 二进制打包

### 归档格式
- **Unix（macOS/Linux）**：`tar.gz`
- **Windows**：`zip`

### 归档结构
```
mongodb/
├── bin/
│   ├── mongod           # 服务器二进制文件
│   ├── mongos           # 分片路由器
│   └── mongosh          # 交互式 shell
└── lib/                 # 共享库（如有）
```

### macOS 扩展属性恢复

`BaseDocumentBinaryManager` 包含对 macOS 扩展属性文件（`._*` 前缀）的特殊处理，这些文件可能导致 tar 解压警告。管理器能够从这些非致命警告中恢复。

### 版本映射同步

```typescript
export const MONGODB_VERSION_MAP: Record<string, string> = {
  '7.0': '7.0.28',
  '8.0': '8.0.x',
  '8.2': '8.2.x',
}
```

## 实现细节

### 二进制管理器

MongoDB 使用 `BaseDocumentBinaryManager`，它在基础管理器之上扩展了以下功能：
- macOS tar 对扩展属性文件的恢复处理
- 主版本匹配验证

### 版本解析

- **版本输出格式**：`db version v7.0.28` 或回退到语义化版本
- **解析模式**：优先匹配 `/db version v(\d+\.\d+\.\d+)/`，回退匹配 `/(\d+\.\d+\.\d+)/`
- **主版本匹配**：验证时仅需主版本匹配

### 默认配置

- **默认端口**：27017（冲突时自动递增）
- **默认数据库**：名称由容器名称派生
- **PID 文件**：容器目录下的 `mongod.pid`

### 隐式数据库创建

MongoDB/FerretDB 在写入数据之前不会创建数据库。要强制立即创建（使数据库在 TablePlus 等工具中可见）：

```javascript
// createDatabase() 实现：
db.getCollection('_spindb_init').insertOne({})
db.getCollection('_spindb_init').drop()
```

此方法会创建并立即删除一个临时集合，使数据库保持可见状态。

### 连接字符串格式

```
mongodb://127.0.0.1:{port}/{database}
```

## 备份与恢复

### 备份格式

| 格式 | 扩展名 | 工具 | 备注 |
|------|--------|------|------|
| bson | （目录） | mongodump | 包含 BSON 文件的目录 |
| archive | `.archive` | mongodump --archive | 单文件归档 |

### 恢复方式

- **BSON 目录**：通过 `mongorestore` 恢复
- **归档格式**：通过 `mongorestore --archive` 恢复

## 集成测试说明

### 保留端口

MongoDB 集成测试使用特定端口范围，以避免与默认 MongoDB 安装冲突。

### 测试数据

位于 `tests/fixtures/mongodb/seeds/`：
- 用于数据操作的测试文档

### Shell 脚本

MongoDB 使用 `mongosh`（现代 shell）执行脚本，而非旧版 `mongo` shell。

## Docker 端到端测试说明

MongoDB 在 Docker E2E 测试中涵盖以下内容：
- 容器生命周期
- 数据库操作
- BSON 和归档备份/恢复
- 多数据库支持

## 已知问题与注意事项

### 1. mongosh 与 mongo

SpinDB 使用 `mongosh`（现代 MongoDB Shell）。旧版 `mongo` shell 已弃用，不再捆绑。

### 2. macOS Tar 警告

在 macOS 上解压 MongoDB 归档文件时，tar 可能会发出关于 `._*` 扩展属性文件的警告。`BaseDocumentBinaryManager` 能够优雅地处理这些警告，不会导致解压失败。

### 3. 数据库可见性

MongoDB 中的数据库在包含数据之前不会出现在 `show dbs` 中。`createDatabase()` 方法使用临时集合技巧强制使其可见。

### 4. Windows 分离式进程

在 Windows 上，MongoDB 使用分离式进程启动（`detached spawn`）并设置 `windowsHide: true` 以实现后台运行。进程通过 PID 文件进行跟踪。

### 5. 首次启动较慢

首次启动可能耗时较长，因为 MongoDB 需要初始化 WiredTiger 存储引擎。

## CI/CD 说明

### GitHub Actions 缓存步骤

```yaml
- name: Cache MongoDB binaries
  uses: actions/cache@v4
  with:
    path: ~/.spindb/bin/mongodb-*
    key: mongodb-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('engines/mongodb/version-maps.ts') }}
```

### Docker E2E 别名

```bash
pnpm test:docker -- mongo
# 或
pnpm test:docker -- mongodb
```
