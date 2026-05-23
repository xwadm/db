# Valkey 引擎实现

## 概述

Valkey 是由 Linux Foundation 维护的 Redis 兼容分支。SpinDB 从 hostdb 下载 Valkey 二进制文件，并以与 Redis 相同的方式管理它们。

## 平台支持

| 平台 | 架构 | 状态 | 备注 |
|----------|--------------|--------|-------|
| darwin | x64 | 已支持 | 使用 hostdb 二进制文件 |
| darwin | arm64 | 已支持 | 使用 hostdb 二进制文件（Apple Silicon） |
| linux | x64 | 已支持 | 使用 hostdb 二进制文件 |
| linux | arm64 | 已支持 | 使用 hostdb 二进制文件 |
| win32 | x64 | 已支持 | **自定义构建的二进制文件**（见下文） |

### Windows 二进制文件 - 自定义构建

**Valkey 没有官方 Windows 二进制文件。** hostdb Windows 二进制文件是**在 Windows 虚拟机中手动构建**的，专门用于 SpinDB。这需要：

1. 搭建 Windows 开发环境
2. 使用 Cygwin 运行时从源码构建 Valkey
3. 将生成的二进制文件与 Cygwin DLL 一起打包
4. 上传到 hostdb

这是 SpinDB 引擎支持中比较特殊的解决方案之一。

### Windows 上的 Cygwin 运行时

Windows 版本的 Valkey 二进制文件使用 Cygwin 构建，这意味着：
- 路径必须转换为 Cygwin 格式
- 二进制文件期望 `/cygdrive/c/...` 风格的路径

```typescript
// Windows 路径转换函数
function toCygwinPath(windowsPath: string): string {
  // C:\Users\foo\config.conf -> /cygdrive/c/Users/foo/config.conf
  const driveMatch = windowsPath.match(/^([A-Za-z]):[/\\]/)
  if (!driveMatch) return windowsPath.replace(/\\/g, '/')

  const driveLetter = driveMatch[1].toLowerCase()
  const restOfPath = windowsPath.slice(3).replace(/\\/g, '/')
  return `/cygdrive/${driveLetter}/${restOfPath}`
}
```

## 二进制文件打包

### 压缩包格式
- **Unix（macOS/Linux）**: `tar.gz`
- **Windows**: `zip`（包含 Cygwin 构建的二进制文件）

### 压缩包结构
```
valkey/
└── bin/
    ├── valkey-server    # 服务器二进制文件
    ├── valkey-cli       # 客户端命令行工具
    ├── valkey-benchmark # 基准测试工具
    └── cygwin1.dll      # Cygwin 运行时库（仅 Windows）
```

### 版本映射同步

```typescript
export const VALKEY_VERSION_MAP: Record<string, string> = {
  '8': '8.0.6',
  '9': '9.x.x',
}
```

## 实现细节

### 二进制文件管理器

Valkey 使用 `BaseBinaryManager`，配置与 Redis 相同。

### 版本解析

- **版本输出格式**: `Valkey server v=8.0.6 sha=00000000:0 malloc=jemalloc-5.3.0...`
- **解析模式**: 先用 `/v=(\d+\.\d+\.\d+)/`，回退到 `/(\d+\.\d+\.\d+)/`

### Redis 兼容性

Valkey 使用 `redis://` 连接方案以保证客户端兼容性：

```
redis://127.0.0.1:{port}/{database}
```

而不使用 `valkey://` —— 这确保与现有 Redis 客户端和工具的兼容性。

### 默认配置

- **默认端口**: 6379（与 Redis 相同，冲突时自动递增）
- **数据库**: 16 个编号数据库（0-15）
- **PID 文件**: 容器目录中的 `valkey.pid`
- **持久化**: 启用 RDB 快照

### 生成的配置

SpinDB 生成包含 Redis 兼容设置的 `valkey.conf`：
```
port {port}
bind 127.0.0.1
dir {dataDir}
daemonize yes     # 仅 Unix
logfile {logFile}
pidfile {pidFile}

# 持久化
save 900 1
save 300 10
save 60 10000
dbfilename dump.rdb
appendonly no
```

### Windows 分离式生成

与 Redis 类似，Valkey 在 Windows 上使用分离式生成：
```typescript
const spawnOpts: SpawnOptions = {
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
  windowsHide: true,
}
// 将路径转换为 Cygwin 格式
const cygwinConfigPath = toCygwinPath(configPath)
spawn(valkeyServer, [cygwinConfigPath], spawnOpts)
```

## 备份与恢复

### 备份格式

| 格式 | 扩展名 | 工具 | 备注 |
|--------|-----------|------|-------|
| text | `.valkey` | 自定义 RESP | 人类可读命令 |
| rdb | `.rdb` | 原生 RDB | 二进制快照 |

与 Redis 备份格式相同，文本格式使用 `.valkey` 扩展名。

## 集成测试说明

### 端口分配

Valkey 测试应避免与 Redis 测试冲突，因为它们共享默认端口 6379。

### 测试固件

位于 `tests/fixtures/valkey/seeds/`：
- 用于测试的键值对

## Docker E2E 测试说明

Valkey Docker E2E 测试验证 Redis 兼容操作：
- 服务器生命周期
- 键值操作
- 备份/恢复
- 数据库切换

## 已知问题与注意事项

### 1. Windows Cygwin 路径

**关键**: Windows 二进制文件期望 Cygwin 风格的路径。直接传递 Windows 路径会失败：
```
# 错误: C:\Users\spindb\valkey.conf
# 正确: /cygdrive/c/Users/spindb/valkey.conf
```

### 2. 无官方 Windows 二进制文件

Windows 支持需要手动编译。如果 Windows 二进制文件出现问题，可能需要在 Windows 虚拟机中从源码重新构建。

### 3. 与 Redis 的端口冲突

Valkey 和 Redis 共享默认端口 6379。SpinDB 通过自动递增来防止冲突。

### 4. iredis 兼容性

`iredis` 增强型 CLI（Python 工具）可与 Valkey 一起使用，因为它是协议兼容的。该引擎检测并支持 `iredis` 作为 `valkey-cli` 的替代方案。

### 5. 连接方案

虽然是 Valkey，但使用 `redis://` 方案：
- `redis://`（明文）
- `rediss://`（TLS）
- 也接受 `valkey://` / `valkeys://` 并自动标准化

## CI/CD 说明

### GitHub Actions 缓存步骤

```yaml
- name: 缓存 Valkey 二进制文件
  uses: actions/cache@v4
  with:
    path: ~/.spindb/bin/valkey-*
    key: valkey-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('engines/valkey/version-maps.ts') }}
```

### Windows CI 注意事项

Valkey 的 Windows CI 测试验证 Cygwin 构建的二进制文件在路径转换下正常工作。

## 构建 Windows 二进制文件

如果需要重新构建 Windows 二进制文件：

1. 搭建带有 Visual Studio Build Tools 的 Windows 虚拟机
2. 安装带有开发包的 Cygwin
3. 克隆 Valkey 源码
4. 使用 `make` 构建
5. 打包 `valkey-server.exe`、`valkey-cli.exe` 和所需的 Cygwin DLL
6. 创建 zip 并上传到 hostdb

这是一个手动过程，未在 CI 中自动化。