# DuckDB 引擎实现

## 概述

DuckDB 是一款嵌入式 OLAP（分析型）数据库。与 SQLite 类似，它基于文件，无需服务端进程。DuckDB 针对分析查询和列式存储进行了优化。

## 平台支持

| 平台 | 架构 | 状态 | 备注 |
|----------|--------------|--------|-------|
| darwin | x64 | 已支持 | 使用 hostdb 二进制 |
| darwin | arm64 | 已支持 | 使用 hostdb 二进制（Apple Silicon） |
| linux | x64 | 已支持 | 使用 hostdb 二进制 |
| linux | arm64 | 已支持 | 使用 hostdb 二进制 |
| win32 | x64 | 已支持 | 使用 hostdb 二进制 |

## 二进制打包

### 归档格式
- **Unix (macOS/Linux)**: `tar.gz`
- **Windows**: `zip`

### 归档结构 - 扁平结构（无 bin/ 子目录）

与 SQLite 一样，DuckDB 归档采用**扁平结构**：

```
duckdb              # 主命令行工具
```

`BaseEmbeddedBinaryManager` 在解压时会将其移动到 `bin/` 目录下。

### 版本映射表同步

```typescript
export const DUCKDB_VERSION_MAP: Record<string, string> = {
  '1': '1.4.3',
}
```

## 实现细节

### 二进制管理器

DuckDB 使用 `BaseEmbeddedBinaryManager`，与 SQLite 一样采用基于文件的模型。

### 版本解析

- **版本输出格式**: `v1.4.3 abcdef123`
- **解析模式**: `/v?(\d+\.\d+\.\d+)/`

### 基于文件的模型

与 SQLite 相同：
- **无需启动/停止**: 空操作
- **无需端口**: 端口始终为 0
- **无需容器目录**: 数据存放在用户的工程目录中
- **注册表追踪**: `~/.spindb/config.json` 追踪文件

### 挂载/卸载命令

- `spindb attach <path>` - 注册已有的 DuckDB 文件
- `spindb detach <name>` - 取消注册（保留文件）

### 连接字符串格式

```
duckdb:/path/to/database.duckdb
```

或者直接使用文件路径。

## 备份与还原

### 备份格式

| 格式 | 扩展名 | 工具 | 备注 |
|--------|-----------|------|-------|
| sql | `.sql` | 自定义导出 | SQL 语句 |
| binary | `.duckdb` | 文件拷贝 | 直接文件拷贝 |

### OLAP 注意事项

由于列式存储格式，DuckDB 备份可能比同等规模的 SQLite 备份更大。二进制备份保留列式布局，便于快速分析查询。

## 集成测试说明

### 测试夹具 (Test Fixtures)

位于 `tests/fixtures/duckdb/seeds/`：
- 用于 OLAP 操作的测试数据

### 无需端口分配

与 SQLite 一样，无服务端意味着无需端口。

## Docker 端到端测试说明

DuckDB Docker E2E 测试验证以下内容：
- 文件操作
- SQL 执行
- 备份/还原
- 挂载/卸载工作流

## 已知问题与注意事项

### 1. 扁平归档结构

与 SQLite 相同 - 二进制文件在根目录，而非 `bin/`。

### 2. OLAP 与 OLTP

DuckDB 针对分析型（OLAP）工作负载优化：
- 列式扫描速度快
- 聚合操作高效
- 单行操作可能较慢

### 3. 内存使用

DuckDB 为追求性能会积极使用内存。大型分析查询可能消耗大量 RAM。

### 4. 文件扩展名

DuckDB 数据库通常使用 `.duckdb` 或 `.db` 扩展名。引擎接受任意扩展名。

### 5. 并发访问

DuckDB 允许多个读取者但仅允许一个写入者。与 SQLite 的锁定模型类似。

### 6. 扩展

DuckDB 支持扩展（parquet、httpfs 等）。加载扩展需要二进制所在目录可写。

## DuckDB 与 SQLite 对比

| 特性 | DuckDB | SQLite |
|---------|--------|--------|
| 工作负载 | OLAP（分析型） | OLTP（事务型） |
| 存储方式 | 列式 | 行式 |
| 大范围扫描 | 非常快 | 较慢 |
| 单行操作 | 较慢 | 非常快 |
| 内存使用 | 积极 | 保守 |

## CI/CD 说明

### GitHub Actions 缓存步骤

```yaml
- name: 缓存 DuckDB 二进制
  uses: actions/cache@v4
  with:
    path: ~/.spindb/bin/duckdb-*
    key: duckdb-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('engines/duckdb/version-maps.ts') }}
```