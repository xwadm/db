# MariaDB 引擎实现

## 概述

MariaDB 是一个兼容 MySQL 的 SQL 数据库。SpinDB 从 hostdb 下载 MariaDB 二进制文件，并使用兼容 MySQL 的工具进行管理。

## 平台支持

| 平台 | 架构 | 状态 | 备注 |
|----------|--------------|--------|-------|
| darwin | x64 | 支持 | 使用 hostdb 二进制文件 |
| darwin | arm64 | 支持 | 使用 hostdb 二进制文件（Apple Silicon） |
| linux | x64 | 支持 | 使用 hostdb 二进制文件 |
| linux | arm64 | 支持 | 使用 hostdb 二进制文件 |
| win32 | x64 | 支持 | 使用 hostdb 二进制文件 |

## 二进制文件打包

### 归档格式
- **Unix（macOS/Linux）**：`tar.gz`
- **Windows**：`zip`

### 归档结构
```text
mariadb/
├── bin/
│   ├── mariadbd         # 服务器二进制文件（新版）
│   ├── mysqld           # 服务器二进制文件（旧版回退）
│   ├── mariadb          # 客户端二进制文件（新版）
│   ├── mysql            # 客户端二进制文件（旧版回退）
│   ├── mariadb-dump     # 备份工具
│   └── mysqldump        # 备份工具（旧版）
├── lib/                 # 共享库
└── share/               # 配置文件
```

### 服务器二进制文件名称

MariaDB 在不同版本中过渡了二进制文件名称：
- **新版本（11.x+）**：`mariadbd`、`mariadb`、`mariadb-dump`
- **旧版本（10.x）**：`mysqld`、`mysql`、`mysqldump`

二进制文件管理器会检查两个名称：`['mariadbd', 'mysqld']`

### 版本映射同步

```typescript
export const MARIADB_VERSION_MAP: Record<string, string> = {
  '10.11': '10.11.15',
  '11.4': '11.4.5',
  '11.8': '11.8.5',
}
```

## 实现细节

### 二进制文件管理器

MariaDB 使用 `BaseServerBinaryManager`，配置了多个服务器二进制文件名称：

```typescript
serverBinaryNames: ['mariadbd', 'mysqld']
```

### 版本解析

- **版本输出格式**：`mariadbd  Ver 11.8.5-MariaDB`
- **解析模式**：`/Ver\s+([\d.]+)/`
- **去除末尾 .0**：与 MySQL 相同的处理方式

### 默认配置

- **默认端口**：3306（与 MySQL 相同，冲突时自动递增）
- **默认数据库**：名称由容器名称派生
- **PID 文件**：容器目录中的 `mariadb.pid`

### 连接字符串格式

```text
mysql://127.0.0.1:{port}/{database}
```

注意：使用 `mysql://` 协议以确保客户端兼容性。

## 备份与恢复

### 备份格式

| 格式 | 扩展名 | 工具 | 备注 |
|--------|-----------|------|-------|
| sql | `.sql` | mariadb-dump/mysqldump | 纯文本 SQL |
| compressed | `.sql.gz` | dump + gzip | 压缩 SQL |

### 工具检测

引擎根据二进制目录中可用的工具，自动检测使用 `mariadb-dump` 还是 `mysqldump`。

## 集成测试说明

### 端口分配

MariaDB 测试可能与 MySQL 测试共享端口范围。请确保测试隔离。

### 测试数据

位于 `tests/fixtures/mariadb/seeds/`：
- `sample-db.sql`：包含 5 条 test_user 记录

## Docker 端到端测试说明

MariaDB 在 Docker 端到端测试中使用兼容 MySQL 的操作进行测试。

## 已知问题与注意事项

### 1. 二进制文件名称过渡

从 `mysqld` 到 `mariadbd` 的过渡意味着引擎必须检查两个二进制文件。始终使用新旧版本的 MariaDB 进行测试。

### 2. MySQL 兼容性

MariaDB 使用 `mysql://` 连接协议以确保客户端兼容性，尽管它是不同的数据库。

### 3. 与 MySQL 的端口冲突

MariaDB 和 MySQL 共享默认端口 3306。SpinDB 通过自动递增防止冲突，但用户应注意同时运行两者时可能出现的问题。

### 4. 客户端工具命名

优先使用 `mariadb-dump` 等客户端工具，但 `mysqldump` 作为回退。引擎的工具检测透明地处理此问题。

## CI/CD 说明

### GitHub Actions 缓存步骤

```yaml
- name: 缓存 MariaDB 二进制文件
  uses: actions/cache@v4
  with:
    path: ~/.spindb/bin/mariadb-*
    key: mariadb-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('engines/mariadb/version-maps.ts') }}
```
