# MySQL 引擎实现

## 概述

MySQL 是传统 SQL 数据库，具有完整的基于服务器的生命周期管理。SpinDB 从 hostdb 下载 MySQL 二进制文件。

## 平台支持

| 平台 | 架构 | 状态 | 备注 |
|----------|--------------|--------|-------|
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
```text
mysql/
├── bin/
│   ├── mysqld           # 服务器二进制文件
│   ├── mysql            # 客户端二进制文件
│   ├── mysqldump        # 备份工具
│   └── mysqladmin       # 管理工具
├── lib/                 # 共享库
└── share/               # 配置文件
```

### 版本映射同步

`version-maps.ts` 文件必须与 hostdb 的 `releases.json` 保持同步：

```typescript
export const MYSQL_VERSION_MAP: Record<string, string> = {
  '8.0': '8.0.40',
  '8.4': '8.4.3',
  '9': '9.5.0',
}
```

## 实现细节

### 二进制管理器

MySQL 使用 `BaseServerBinaryManager` 和标准配置。

### 版本解析

- **版本输出格式**：`mysqld  Ver 8.0.40`
- **解析模式**：`/Ver\s+([\d.]+)/`
- **去除末尾 .0**：处理 4 段版本号，如 `8.0.40.0` → `8.0.40`

### 服务器二进制文件名

MySQL 使用 `mysqld`（带 'd' 表示守护进程）作为服务器二进制文件，与 PostgreSQL 的 `postgres` 不同。

### 默认配置

- **默认端口**：3306（冲突时自动递增）
- **默认数据库**：名称由容器名派生
- **PID 文件**：容器目录中的 `mysql.pid`

### 初始化

MySQL 使用 `mysqld --initialize-insecure` 创建数据目录，无需 root 密码，适用于本地开发。

### 连接字符串格式

```text
mysql://127.0.0.1:{port}/{database}
```

## 备份与恢复

### 备份格式

| 格式 | 扩展名 | 工具 | 备注 |
|--------|-----------|------|-------|
| sql | `.sql` | mysqldump | 纯文本 SQL |
| compressed | `.sql.gz` | mysqldump + gzip | 压缩 SQL |

### 恢复方法

- **SQL 格式**：通过 `mysql < file.sql` 恢复
- **压缩格式**：`gunzip -c file.sql.gz | mysql`

## 集成测试说明

### 保留端口

集成测试使用保留端口以避免冲突：
- **测试端口**：3333-3335（非 3306）

### 测试夹具

位于 `tests/fixtures/mysql/seeds/`：
- `sample-db.sql`：包含 5 条 test_user 记录

## Docker E2E 测试说明

MySQL 在 Docker E2E 中进行全生命周期验证测试：
- 容器创建
- 服务器启动/停止
- 数据库操作
- 备份和恢复

## 已知问题与注意事项

### 1. 初始化时间

MySQL 的 `--initialize-insecure` 在首次启动时可能比其他数据库耗时更长。引擎允许初始设置时使用更长的超时时间。

### 2. Socket vs TCP

默认情况下，SpinDB 配置 MySQL 仅使用 TCP 连接（不使用 Unix socket），以保证跨平台一致性。

### 3. Root 用户

为方便本地开发，MySQL 容器创建时不设 root 密码。默认用户为 'root'，无密码。

### 4. 关闭缓慢

MySQL 优雅关闭可能需要数秒。引擎会等待进程正确终止后再报告已停止状态。

## CI/CD 说明

### GitHub Actions 缓存步骤

MySQL 二进制文件在 CI 中缓存：
```yaml
- name: Cache MySQL binaries
  uses: actions/cache@v4
  with:
    path: ~/.spindb/bin/mysql-*
    key: mysql-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('engines/mysql/version-maps.ts') }}
```