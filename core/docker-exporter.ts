/**
 * Docker 导出器
 *
 * 生成 Docker 构件（Dockerfile、docker-compose.yml、entrypoint.sh 等）
 * 用于在 Docker 中运行 SpinDB 容器。
 *
 * 架构：SpinDB 在容器内运行并管理数据库，
 * 使用与本地开发相同的 hostdb 二进制文件。
 */

import { mkdir, writeFile, copyFile, rm, readdir, readFile } from 'fs/promises'
import { join, basename } from 'path'
import { existsSync } from 'fs'
import { homedir } from 'os'
import {
  type ContainerConfig,
  Engine,
  isFileBasedEngine,
  assertExhaustive,
} from '../types'
import { engineDefaults } from '../config/engine-defaults'
import { getDefaultFormat, getBackupExtension } from '../config/backup-formats'
import { generateCredentials, type Credentials } from './credential-generator'
import { generateTLSCertificates, isOpenSSLAvailable } from './tls-generator'
import { withTransaction } from './transaction-manager'

export type DockerExportOptions = {
  // Docker 构件的输出目录
  outputDir: string
  // 覆盖外部端口（默认：与容器端口相同）
  port?: number
  // 是否包含数据库备份（默认：true）
  includeData?: boolean
  // 使用现有备份文件路径代替创建新备份（单数据库）
  backupPath?: string
  // 多数据库备份文件路径
  backupPaths?: Array<{ database: string; path: string }>
  // 是否跳过 TLS 证书生成（默认：false）
  skipTLS?: boolean
}

export type DockerExportResult = {
  outputDir: string
  credentials: Credentials
  port: number
  engine: Engine
  version: string
  database: string
  files: string[]
}

/**
 * 获取引擎的显示名称
 */
function getEngineDisplayName(engine: Engine): string {
  const displayNames: Record<Engine, string> = {
    [Engine.PostgreSQL]: 'PostgreSQL',
    [Engine.MySQL]: 'MySQL',
    [Engine.MariaDB]: 'MariaDB',
    [Engine.SQLite]: 'SQLite',
    [Engine.DuckDB]: 'DuckDB',
    [Engine.MongoDB]: 'MongoDB',
    [Engine.FerretDB]: 'FerretDB',
    [Engine.Redis]: 'Redis',
    [Engine.Valkey]: 'Valkey',
    [Engine.ClickHouse]: 'ClickHouse',
    [Engine.Qdrant]: 'Qdrant',
    [Engine.Meilisearch]: 'Meilisearch',
    [Engine.CouchDB]: 'CouchDB',
    [Engine.CockroachDB]: 'CockroachDB',
    [Engine.SurrealDB]: 'SurrealDB',
    [Engine.QuestDB]: 'QuestDB',
    [Engine.TypeDB]: 'TypeDB',
    [Engine.InfluxDB]: 'InfluxDB',
    [Engine.Weaviate]: 'Weaviate',
    [Engine.TigerBeetle]: 'TigerBeetle',
    [Engine.LibSQL]: 'libSQL',
  }
  return displayNames[engine] || engine
}

/**
 * Docker 导出的引擎二进制配置
 *
 * 定义每个引擎的主要二进制文件，用于 PATH 设置和文档。
 * 此结构支持未来的增强：
 * - excludedBinaries: 从 PATH 中排除的二进制文件（例如内部工具）
 * - renamedBinaries: 原始名 -> 重命名映射（例如避免冲突）
 * - priority: 多引擎容器中，哪个引擎的二进制文件优先
 */
const _ENGINE_BINARY_CONFIG: Record<
  Engine,
  {
    primaryBinaries: string[]
  }
> = {
  [Engine.PostgreSQL]: {
    primaryBinaries: ['psql', 'pg_dump', 'pg_restore', 'createdb', 'dropdb'],
  },
  [Engine.MySQL]: {
    primaryBinaries: ['mysql', 'mysqldump', 'mysqladmin'],
  },
  [Engine.MariaDB]: {
    primaryBinaries: ['mariadb', 'mariadb-dump', 'mariadb-admin'],
  },
  [Engine.SQLite]: {
    primaryBinaries: ['sqlite3'],
  },
  [Engine.DuckDB]: {
    primaryBinaries: ['duckdb'],
  },
  [Engine.MongoDB]: {
    primaryBinaries: ['mongosh', 'mongodump', 'mongorestore'],
  },
  [Engine.FerretDB]: {
    primaryBinaries: ['mongosh', 'psql'], // FerretDB 使用 mongosh + PostgreSQL 后端
  },
  [Engine.Redis]: {
    primaryBinaries: ['redis-cli', 'redis-server'],
  },
  [Engine.Valkey]: {
    primaryBinaries: ['valkey-cli', 'valkey-server'],
  },
  [Engine.ClickHouse]: {
    primaryBinaries: ['clickhouse', 'clickhouse-client'],
  },
  [Engine.Qdrant]: {
    primaryBinaries: [], // 仅 REST API，无 CLI 工具
  },
  [Engine.Meilisearch]: {
    primaryBinaries: [], // 仅 REST API，无 CLI 工具
  },
  [Engine.CouchDB]: {
    primaryBinaries: [], // 仅 REST API，无 CLI 工具
  },
  [Engine.CockroachDB]: {
    primaryBinaries: ['cockroach'],
  },
  [Engine.SurrealDB]: {
    primaryBinaries: ['surreal'],
  },
  [Engine.QuestDB]: {
    primaryBinaries: [], // 使用 PostgreSQL 的 psql 进行连接
  },
  [Engine.TypeDB]: {
    primaryBinaries: ['typedb', 'typedb_console_bin'],
  },
  [Engine.InfluxDB]: {
    primaryBinaries: [], // 仅 REST API，无 CLI 工具
  },
  [Engine.Weaviate]: {
    primaryBinaries: [], // 仅 REST/GraphQL API，无 CLI 工具
  },
  [Engine.TigerBeetle]: {
    primaryBinaries: ['tigerbeetle'],
  },
  [Engine.LibSQL]: {
    primaryBinaries: [], // 仅 REST API，无 CLI 工具
  },
}

/**
 * 获取引擎的连接字符串模板
 * 包含凭据占位符，可选包含 TLS 参数
 *
 * @param engine - 数据库引擎
 * @param port - 端口号
 * @param database - 数据库名称
 * @param useTLS - 是否包含 TLS 参数（默认：true）
 */
function getConnectionStringTemplate(
  engine: Engine,
  port: number,
  database: string,
  useTLS = true,
): string {
  switch (engine) {
    case Engine.PostgreSQL:
    case Engine.CockroachDB:
    case Engine.QuestDB:
      return useTLS
        ? `postgresql://\${SPINDB_USER}:\${SPINDB_PASSWORD}@<host>:${port}/${database}?sslmode=require`
        : `postgresql://\${SPINDB_USER}:\${SPINDB_PASSWORD}@<host>:${port}/${database}`

    case Engine.MySQL:
    case Engine.MariaDB:
      return useTLS
        ? `mysql://\${SPINDB_USER}:\${SPINDB_PASSWORD}@<host>:${port}/${database}?ssl=true`
        : `mysql://\${SPINDB_USER}:\${SPINDB_PASSWORD}@<host>:${port}/${database}`

    case Engine.MongoDB:
    case Engine.FerretDB:
      return useTLS
        ? `mongodb://\${SPINDB_USER}:\${SPINDB_PASSWORD}@<host>:${port}/${database}?tls=true`
        : `mongodb://\${SPINDB_USER}:\${SPINDB_PASSWORD}@<host>:${port}/${database}`

    case Engine.Redis:
    case Engine.Valkey:
      return useTLS
        ? `rediss://:\${SPINDB_PASSWORD}@<host>:${port}`
        : `redis://:\${SPINDB_PASSWORD}@<host>:${port}`

    case Engine.ClickHouse:
      return useTLS
        ? `clickhouse://\${SPINDB_USER}:\${SPINDB_PASSWORD}@<host>:${port}/${database}?secure=true`
        : `clickhouse://\${SPINDB_USER}:\${SPINDB_PASSWORD}@<host>:${port}/${database}`

    case Engine.Qdrant:
      return useTLS ? `https://<host>:${port}` : `http://<host>:${port}`

    case Engine.Meilisearch:
    case Engine.InfluxDB:
    case Engine.Weaviate:
    case Engine.LibSQL:
      return useTLS ? `https://<host>:${port}` : `http://<host>:${port}`

    case Engine.CouchDB:
      return useTLS
        ? `https://\${SPINDB_USER}:\${SPINDB_PASSWORD}@<host>:${port}/${database}`
        : `http://\${SPINDB_USER}:\${SPINDB_PASSWORD}@<host>:${port}/${database}`

    case Engine.SurrealDB:
      return useTLS
        ? `wss://\${SPINDB_USER}:\${SPINDB_PASSWORD}@<host>:${port}`
        : `ws://\${SPINDB_USER}:\${SPINDB_PASSWORD}@<host>:${port}`

    case Engine.TypeDB:
      return `typedb://<host>:${port}`

    case Engine.TigerBeetle:
      return `<host>:${port}`

    case Engine.SQLite:
    case Engine.DuckDB:
      return `基于文件的数据库（无网络连接）`

    default:
      assertExhaustive(
        engine,
        `getConnectionUri 中未处理的引擎: ${engine}`,
      )
  }
}

/**
 * 生成 Dockerfile 内容
 */
function generateDockerfile(
  engine: Engine,
  isFileBased: boolean,
  useTLS: boolean,
): string {
  // 基于文件的引擎没有运行中的服务器，因此检查容器是否存在
  // 基于服务器的引擎检查运行状态
  const healthcheck = isFileBased
    ? `HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \\
    CMD gosu spindb spindb list --json | grep -q '"engine":.*"${engine}"'`
    : `HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \\
    CMD gosu spindb spindb list --json | grep -q '"status":.*"running"'`

  // 仅在生成了 TLS 证书时复制
  const copyCerts = useTLS
    ? `
# 复制 TLS 证书
COPY --chown=spindb:spindb ./certs/ /home/spindb/.spindb/certs/
`
    : ''

  return `# SpinDB Docker 容器
# 在 Docker 内运行 SpinDB 以管理数据库生命周期

FROM ubuntu:22.04

# 防止包安装时出现交互式提示
ENV DEBIAN_FRONTEND=noninteractive

# 安装基础依赖
# libnuma1: PostgreSQL 二进制文件所需
# libxml2: PostgreSQL 所需的 XML 库
# libicu70: PostgreSQL 所需的 ICU 库（Ubuntu 22.04 附带 ICU 70）
# libaio1: MySQL 所需的异步 I/O 库
# libncurses6: MariaDB 所需的终端库
# locales: PostgreSQL 区域设置配置所需
# lsof: SpinDB 的 findProcessByPort() 所需
# gosu: 用于以非 root 用户运行命令
RUN apt-get update && apt-get install -y \\
    curl \\
    openssl \\
    ca-certificates \\
    gnupg \\
    libnuma1 \\
    libxml2 \\
    libicu70 \\
    libaio1 \\
    libncurses6 \\
    locales \\
    lsof \\
    gosu \\
    && locale-gen en_US.UTF-8 \\
    && rm -rf /var/lib/apt/lists/*

# 设置区域环境变量
ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8

# 安装 Node.js 22 LTS（匹配 SpinDB 的引擎要求）
RUN mkdir -p /etc/apt/keyrings \\
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \\
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list \\
    && apt-get update \\
    && apt-get install -y nodejs \\
    && rm -rf /var/lib/apt/lists/*

# 创建 spindb 用户（数据库进程使用非 root 用户）
RUN groupadd -r spindb && useradd -r -g spindb -d /home/spindb -m -s /bin/bash spindb

# 通过 npm 全局安装 SpinDB。此处故意不使用 pnpm：pnpm
# 10+ 需要 \`pnpm setup\` 将 PNPM_HOME 写入 shell 配置文件后
# \`pnpm add -g\` 才能工作，但 Dockerfile 的 RUN 不会在步骤中途加载配置文件，
# 且 pnpm 11.x 在干净容器中存在 @pnpm/exe 安装 bug。对于单个
# 全局包，npm 更简单可靠。
RUN npm install -g spindb \\
    && npm cache clean --force

# 创建 spindb 目录并设置正确权限
RUN mkdir -p /home/spindb/.spindb/containers /home/spindb/.spindb/bin /home/spindb/.spindb/certs /home/spindb/.spindb/init \\
    && chown -R spindb:spindb /home/spindb
${copyCerts}
# 复制数据库备份/数据
COPY --chown=spindb:spindb ./data/ /home/spindb/.spindb/init/

# 复制入口脚本
COPY ./entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 环境变量（可覆盖）
ENV SPINDB_ENGINE=${engine}
ENV HOME=/home/spindb

# 暴露数据库端口
EXPOSE \${SPINDB_PORT:-${engineDefaults[engine].defaultPort}}

# 健康检查（以 spindb 用户运行）
${healthcheck}

ENTRYPOINT ["/entrypoint.sh"]
`
}

/**
 * 生成 entrypoint.sh 内容
 */
function generateEntrypoint(
  engine: Engine,
  containerName: string,
  database: string,
  databases: string[],
  version: string,
  port: number,
  useTLS: boolean,
): string {
  const isFileBased = isFileBasedEngine(engine)

  // 引擎特定的网络配置（在 create 之后、start 之前运行）
  // 配置数据库接受来自 Docker 网络的连接
  let networkConfig = ''

  switch (engine) {
    case Engine.PostgreSQL:
    case Engine.CockroachDB:
      // PostgreSQL/CockroachDB 需要监听所有接口并允许网络连接
      networkConfig = `
# 配置 PostgreSQL 接受来自 Docker 网络的连接
echo "Configuring network access..."
PG_CONF="/home/spindb/.spindb/containers/${engine}/\${CONTAINER_NAME}/data/postgresql.conf"
PG_HBA="/home/spindb/.spindb/containers/${engine}/\${CONTAINER_NAME}/data/pg_hba.conf"

# 设置 listen_addresses 以允许来自任何接口的连接
if [ -f "$PG_CONF" ]; then
    sed -i "s/^#*listen_addresses.*/listen_addresses = '*'/" "$PG_CONF"
fi

# 添加规则允许来自任何 IP 的密码认证连接
if [ -f "$PG_HBA" ] && ! grep -q "0.0.0.0/0" "$PG_HBA"; then
    echo "host    all             all             0.0.0.0/0               scram-sha-256" >> "$PG_HBA"
fi
`
      break

    default:
      // 其他引擎不需要特殊网络配置（默认监听所有接口）
      break
  }

  // 引擎特定的用户创建命令
  let userCreationCommands = ''

  switch (engine) {
    case Engine.PostgreSQL:
      userCreationCommands = `
# 创建带密码的用户
echo "[$(date '+%H:%M:%S')] Creating database user '$SPINDB_USER'..."
cat > /tmp/create-user.sql <<EOSQL
DO \\$\\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '$SPINDB_USER') THEN
    CREATE ROLE "$SPINDB_USER" WITH LOGIN PASSWORD '$SPINDB_PASSWORD' CREATEDB;
  ELSE
    ALTER ROLE "$SPINDB_USER" WITH PASSWORD '$SPINDB_PASSWORD';
  END IF;
END
\\$\\$;
GRANT ALL PRIVILEGES ON DATABASE "$DATABASE" TO "$SPINDB_USER";
EOSQL
if ! run_as_spindb spindb run "$CONTAINER_NAME" /tmp/create-user.sql --database postgres; then
    echo "[$(date '+%H:%M:%S')] ERROR: Failed to create database user"
    rm -f /tmp/create-user.sql
    exit 1
fi
rm -f /tmp/create-user.sql
echo "[$(date '+%H:%M:%S')] User '$SPINDB_USER' created successfully"
`
      break

    case Engine.MySQL:
    case Engine.MariaDB:
      userCreationCommands = `
# 创建带密码的用户
echo "Creating database user..."
cat > /tmp/create-user.sql <<EOSQL
CREATE USER IF NOT EXISTS '$SPINDB_USER'@'%' IDENTIFIED BY '$SPINDB_PASSWORD';
GRANT ALL PRIVILEGES ON \\\`$DATABASE\\\`.* TO '$SPINDB_USER'@'%';
FLUSH PRIVILEGES;
EOSQL
run_as_spindb spindb run "$CONTAINER_NAME" /tmp/create-user.sql --database mysql
rm -f /tmp/create-user.sql
`
      break

    case Engine.MongoDB:
    case Engine.FerretDB:
      userCreationCommands = `
# 创建带密码的用户
echo "Creating database user..."
cat > /tmp/create-user.js <<EOJS
db.createUser({
  user: "$SPINDB_USER",
  pwd: "$SPINDB_PASSWORD",
  roles: [{ role: "readWrite", db: "$DATABASE" }]
});
EOJS
run_as_spindb spindb run "$CONTAINER_NAME" /tmp/create-user.js --database admin
rm -f /tmp/create-user.js
`
      break

    case Engine.Redis:
    case Engine.Valkey:
      // Redis 使用 requirepass，在启动时配置
      userCreationCommands = `
# Redis/Valkey 认证在服务器启动时通过 --requirepass 配置
echo "Authentication configured via server settings"
`
      break

    case Engine.ClickHouse:
      userCreationCommands = `
# 创建带密码的用户
echo "Creating database user..."
cat > /tmp/create-user.sql <<EOSQL
CREATE USER IF NOT EXISTS $SPINDB_USER IDENTIFIED BY '$SPINDB_PASSWORD';
GRANT ALL ON $DATABASE.* TO $SPINDB_USER;
EOSQL
run_as_spindb spindb run "$CONTAINER_NAME" /tmp/create-user.sql
rm -f /tmp/create-user.sql
`
      break

    case Engine.CouchDB:
      userCreationCommands = `
# CouchDB 管理员用户在服务器启动时配置
echo "Admin credentials configured via server settings"
`
      break

    case Engine.CockroachDB:
      userCreationCommands = `
# 创建带密码的用户
echo "Creating database user..."
cat > /tmp/create-user.sql <<EOSQL
CREATE USER IF NOT EXISTS $SPINDB_USER WITH PASSWORD '$SPINDB_PASSWORD';
GRANT ALL ON DATABASE $DATABASE TO $SPINDB_USER;
EOSQL
run_as_spindb spindb run "$CONTAINER_NAME" /tmp/create-user.sql --database defaultdb
rm -f /tmp/create-user.sql
`
      break

    case Engine.SurrealDB:
      userCreationCommands = `
# SurrealDB 凭据在服务器启动时配置
echo "Credentials configured via server settings"
`
      break

    case Engine.QuestDB:
      userCreationCommands = `
# QuestDB 用户通过配置设置
echo "User configured via server settings"
`
      break

    case Engine.Qdrant:
    case Engine.Meilisearch:
    case Engine.Weaviate:
      userCreationCommands = `
# API 密钥在服务器启动时配置
echo "API key configured via server settings"
`
      break

    case Engine.InfluxDB:
      userCreationCommands = `
# InfluxDB 3.x 本地开发无需认证运行
echo "No authentication required for local InfluxDB 3.x"
`
      break

    case Engine.TypeDB:
      userCreationCommands = `
# TypeDB 社区版不支持用户管理
echo "No authentication required"
`
      break

    case Engine.TigerBeetle:
      userCreationCommands = `
# TigerBeetle 无认证机制
echo "No authentication required"
`
      break

    case Engine.LibSQL:
      userCreationCommands = `
# libSQL 本地开发无需认证运行
echo "No authentication required"
`
      break

    case Engine.SQLite:
    case Engine.DuckDB:
      userCreationCommands = `
# 基于文件的数据库 - 无需创建用户
echo "File-based database initialized"
`
      break

    default:
      assertExhaustive(
        engine,
        `generateEntrypoint 中未处理的引擎: ${engine}`,
      )
  }

  // 为所有数据库生成恢复命令
  // 注意：使用 /home/spindb/.spindb/init/ 因为容器以 spindb 用户运行
  const initDir = '/home/spindb/.spindb/init'
  const fileExt = engine === Engine.SQLite ? 'sqlite' : 'duckdb'
  // 基于文件的路径在 shell 脚本中通过 $FILE_DB_PATH 在运行时计算
  const restoreSection = isFileBased
    ? `
# 基于文件的数据库 - 将数据文件复制到 spindb create --path 使用的路径
if ls ${initDir}/*.${fileExt} 1> /dev/null 2>&1; then
    echo "Copying database file..."
    cp ${initDir}/*.${fileExt} "$FILE_DB_PATH"
fi
`
    : databases.length > 1
      ? `
# 恢复所有数据库的数据
echo "[$(date '+%H:%M:%S')] Checking for backup files in ${initDir}..."
ls -la ${initDir}/ 2>/dev/null || echo "  (directory empty or not found)"
DATABASES="${databases.join(' ')}"
for DB in $DATABASES; do
    # 查找此数据库的备份文件（模式：containerName-dbName.*）
    BACKUP_FILE=$(ls ${initDir}/${containerName}-$DB.* 2>/dev/null | head -1)
    if [ -n "$BACKUP_FILE" ]; then
        echo "[$(date '+%H:%M:%S')] Found backup for database '$DB': $BACKUP_FILE"
        # 如果尚未跟踪，则添加数据库到跟踪列表
        run_as_spindb spindb databases add "$CONTAINER_NAME" "$DB" 2>/dev/null || true
        if ! run_as_spindb spindb restore "$CONTAINER_NAME" "$BACKUP_FILE" --database "$DB" --force; then
            echo "[$(date '+%H:%M:%S')] ERROR: Restore of '$DB' failed"
            exit 1
        fi
        echo "[$(date '+%H:%M:%S')] Restore of '$DB' completed successfully"
    else
        echo "[$(date '+%H:%M:%S')] WARNING: No backup file found for database '$DB'"
    fi
done
`
      : `
# 如果存在备份则恢复数据
echo "[$(date '+%H:%M:%S')] Checking for backup files in ${initDir}..."
ls -la ${initDir}/ 2>/dev/null || echo "  (directory empty or not found)"
if ls ${initDir}/* 1> /dev/null 2>&1; then
    BACKUP_FILE=$(ls ${initDir}/* | head -1)
    echo "[$(date '+%H:%M:%S')] Found backup file: $BACKUP_FILE"
    echo "[$(date '+%H:%M:%S')] Restoring to database '$DATABASE'..."
    if ! run_as_spindb spindb restore "$CONTAINER_NAME" "$BACKUP_FILE" --database "$DATABASE" --force; then
        echo "[$(date '+%H:%M:%S')] ERROR: Restore failed with exit code $?"
        exit 1
    fi
    echo "[$(date '+%H:%M:%S')] Restore completed successfully"
else
    echo "[$(date '+%H:%M:%S')] WARNING: No backup files found in ${initDir}"
fi
`

  // 恢复后命令 - 向 spindb 用户授予表/序列权限
  // 恢复期间创建的表归 postgres 所有，因此 spindb 用户需要授权
  let postRestoreCommands = ''

  switch (engine) {
    case Engine.PostgreSQL:
    case Engine.CockroachDB:
      postRestoreCommands = `
# 向 spindb 用户授予表和序列权限
# （恢复的表归 postgres 所有，spindb 用户需要访问权限）
echo "[$(date '+%H:%M:%S')] Granting table permissions to '$SPINDB_USER'..."
cat > /tmp/grant-permissions.sql <<EOSQL
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO "$SPINDB_USER";
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO "$SPINDB_USER";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO "$SPINDB_USER";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO "$SPINDB_USER";
EOSQL
if ! run_as_spindb spindb run "$CONTAINER_NAME" /tmp/grant-permissions.sql --database "$DATABASE"; then
    echo "[$(date '+%H:%M:%S')] ERROR: Failed to grant permissions"
    rm -f /tmp/grant-permissions.sql
    exit 1
fi
rm -f /tmp/grant-permissions.sql
echo "[$(date '+%H:%M:%S')] Permissions granted successfully"
`
      break

    case Engine.MySQL:
    case Engine.MariaDB:
      // MySQL 的权限已在用户创建中的 GRANT ALL ON database.* 处理
      postRestoreCommands = ''
      break

    default:
      // 其他引擎不需要恢复后权限授予
      postRestoreCommands = ''
      break
  }

  return `#!/bin/bash
set -e

# 容器配置（来自环境变量）
CONTAINER_NAME="\${SPINDB_CONTAINER:-${containerName}}"
DATABASE="\${SPINDB_DATABASE:-${database}}"
ENGINE="\${SPINDB_ENGINE:-${engine}}"
VERSION="\${SPINDB_VERSION:-${version}}"
PORT="\${SPINDB_PORT:-${port}}"
SPINDB_USER="\${SPINDB_USER:-spindb}"
SPINDB_PASSWORD="\${SPINDB_PASSWORD:?Error: SPINDB_PASSWORD environment variable is required}"

# 验证密码不包含会破坏 SQL/JS here-doc 的字符
# 这些字符会导致用户创建命令中出现语法错误
if echo "$SPINDB_PASSWORD" | grep -qE "['"'\\\`$!]'; then
    echo "ERROR: SPINDB_PASSWORD contains unsafe characters for shell scripts." >&2
    echo 'Avoid using: '"'"' " \\ \` $ ! in passwords when running in Docker.' >&2
    echo "These characters break SQL/JS here-docs in the entrypoint script." >&2
    exit 1
fi
${
  isFileBased
    ? `
# 基于文件的数据库路径（从运行时 CONTAINER_NAME 计算）
FILE_DB_PATH="/home/spindb/.spindb/containers/${engine}/\${CONTAINER_NAME}/\${CONTAINER_NAME}.${fileExt}"
`
    : ''
}
# 为 spindb 用户导出环境变量
export SPINDB_CONTAINER SPINDB_DATABASE SPINDB_ENGINE SPINDB_VERSION SPINDB_PORT SPINDB_USER SPINDB_PASSWORD

# PATH 将在 spindb 下载引擎二进制文件后更新

# 修复挂载卷的权限（可能以 root 所有者创建）
echo "Setting up directories..."
chown -R spindb:spindb /home/spindb/.spindb 2>/dev/null || true

echo "========================================"
echo "SpinDB Docker Container"
echo "========================================"
echo "Engine: $ENGINE $VERSION"
echo "Container: $CONTAINER_NAME"
echo "Database: $DATABASE"
echo "Port: $PORT"
echo "========================================"

# 以 spindb 用户运行所有 spindb 命令（数据库不能以 root 运行）
run_as_spindb() {
    gosu spindb "$@"
}

# 检查容器是否已存在
if run_as_spindb spindb list --json 2>/dev/null | grep -q '"name": "'"$CONTAINER_NAME"'"'; then
    echo "[$(date '+%H:%M:%S')] Container '$CONTAINER_NAME' already exists"
    ${
      isFileBased
        ? `# 基于文件的数据库：没有服务器需要启动`
        : `# 检查数据库是否正在运行，如未运行则启动（处理 Docker 重启）
    if ! run_as_spindb spindb list --json 2>/dev/null | grep -q '"status":.*"running"'; then
        echo "[$(date '+%H:%M:%S')] Database not running, starting..."
        if ! run_as_spindb spindb start "$CONTAINER_NAME"; then
            echo "[$(date '+%H:%M:%S')] ERROR: Failed to start database"
            exit 1
        fi
    fi`
    }
else
    echo "[$(date '+%H:%M:%S')] Creating container '$CONTAINER_NAME'..."
    ${
      isFileBased
        ? `# 基于文件的数据库：为数据库文件使用确定性路径
    if ! run_as_spindb spindb create "$CONTAINER_NAME" --engine "$ENGINE" --db-version "$VERSION" --path "$FILE_DB_PATH" --force; then
        echo "[$(date '+%H:%M:%S')] ERROR: Failed to create container"
        exit 1
    fi`
        : `# 使用 --start 确保数据库被创建（非 TTY 默认不启动）
    if ! run_as_spindb spindb create "$CONTAINER_NAME" --engine "$ENGINE" --db-version "$VERSION" --port "$PORT" --database "$DATABASE" --force --start; then
        echo "[$(date '+%H:%M:%S')] ERROR: Failed to create container"
        exit 1
    fi`
    }
    echo "[$(date '+%H:%M:%S')] Container created successfully"
fi

# 将引擎二进制目录添加到 PATH（幂等操作 - 仅在不存在时添加）
# 允许用户在容器中直接运行 psql、mysql 等
# 注意：我们将实际的 bin 目录添加到 PATH，而不是创建符号链接
# 因为某些二进制文件（如 psql）是使用相对路径的包装脚本
echo "Setting up database binaries in PATH..."
BIN_DIR=$(ls -d /home/spindb/.spindb/bin/\${ENGINE}-*/bin 2>/dev/null | head -1)
if [ -d "$BIN_DIR" ]; then
    export PATH="$BIN_DIR:$PATH"
    # 在 /etc/profile.d 中创建/覆盖脚本以实现系统级访问（幂等）
    # 确保 PATH 在登录 shell 中设置且不重复
    echo "export PATH=\\"$BIN_DIR:\\$PATH\\"" > /etc/profile.d/spindb-bins.sh
    echo "Binaries available in PATH: $(ls "$BIN_DIR" | tr '\\n' ' ')"
else
    echo "Warning: No engine binaries found"
fi
${networkConfig}${
    isFileBased
      ? `
# 基于文件的数据库：没有服务器需要启动，只需在恢复后验证文件存在
`
      : `
# 数据库已由上面的 'spindb create --start' 启动
# 等待数据库完全准备好接受连接
echo "[$(date '+%H:%M:%S')] Waiting for database to be ready..."
RETRIES=30
until run_as_spindb spindb list --json 2>/dev/null | grep -q '"status":.*"running"' || [ $RETRIES -eq 0 ]; do
    echo "[$(date '+%H:%M:%S')] Waiting for database... ($RETRIES attempts remaining)"
    sleep 2
    RETRIES=$((RETRIES-1))
done

if [ $RETRIES -eq 0 ]; then
    echo "[$(date '+%H:%M:%S')] ERROR: Database failed to start"
    exit 1
fi`
  }

echo "[$(date '+%H:%M:%S')] Database is running!"

# 初始化标记文件 - 确保用户创建和数据恢复只运行一次
INIT_MARKER="/home/spindb/.spindb/.initialized-$CONTAINER_NAME"
if [ ! -f "$INIT_MARKER" ]; then
    echo "[$(date '+%H:%M:%S')] ======== FIRST-TIME INITIALIZATION ========"
${userCreationCommands}
${restoreSection}
${postRestoreCommands}
    # 标记初始化完成
    touch "$INIT_MARKER"
    chown spindb:spindb "$INIT_MARKER"
    echo "[$(date '+%H:%M:%S')] ======== INITIALIZATION COMPLETE ========"
else
    echo "[$(date '+%H:%M:%S')] Container already initialized, skipping data restore."
fi

echo "========================================"
echo "SPINDB_READY"
echo "SpinDB container ready!"
echo ""
echo "Connection: ${getConnectionStringTemplate(engine, port, database, useTLS).replace(/\$/g, '\\$')}"
echo "========================================"
${
  isFileBased
    ? `
# 基于文件的数据库：保持容器运行（没有服务器需要监控）
exec tail -f /dev/null`
    : `
# 保持容器运行
# 捕获 SIGTERM 和 SIGINT 以实现优雅关闭
trap "echo 'Shutting down...'; run_as_spindb spindb stop '$CONTAINER_NAME'; exit 0" SIGTERM SIGINT

# 保持容器运行（以 spindb 用户）
exec gosu spindb tail -f /dev/null &
while true; do
    sleep 60
    # 检查数据库是否仍在运行
    if ! run_as_spindb spindb list --json 2>/dev/null | grep -q '"status":.*"running"'; then
        echo "Database stopped unexpectedly, restarting..."
        run_as_spindb spindb start "$CONTAINER_NAME" || true
    fi
done`
}
`
}

/**
 * 生成 docker-compose.yml 内容
 */
function generateDockerCompose(
  containerName: string,
  engine: Engine,
  version: string,
  port: number,
  database: string,
  isFileBased: boolean,
): string {
  // 与 Dockerfile 行为匹配的引擎感知健康检查
  // 基于服务器：检查运行状态
  // 基于文件：检查容器是否存在（没有服务器进程可检查）
  // 注意：双引号必须在 YAML 字符串上下文中转义
  const healthcheckCommand = isFileBased
    ? `gosu spindb spindb list --json | grep -q '\\"engine\\":.*\\"${engine}\\"'`
    : `gosu spindb spindb list --json | grep -q '\\"status\\":.*\\"running\\"'`

  const startPeriod = isFileBased ? '30s' : '60s'

  return `name: spindb-${containerName}

services:
  ${containerName}:
    build: .
    container_name: spindb-${containerName}
    restart: unless-stopped
    environment:
      SPINDB_CONTAINER: \${CONTAINER_NAME:-${containerName}}
      SPINDB_ENGINE: \${ENGINE:-${engine}}
      SPINDB_VERSION: \${VERSION:-${version}}
      SPINDB_PORT: \${PORT:-${port}}
      SPINDB_DATABASE: \${DATABASE:-${database}}
      SPINDB_USER: \${SPINDB_USER:-spindb}
      SPINDB_PASSWORD: \${SPINDB_PASSWORD:?Set SPINDB_PASSWORD in .env file}
    ports:
      - "\${PORT:-${port}}:\${PORT:-${port}}"
    volumes:
      - spindb-data:/home/spindb/.spindb
    healthcheck:
      test: ["CMD-SHELL", "${healthcheckCommand}"]
      interval: 30s
      timeout: 10s
      start_period: ${startPeriod}
      retries: 3

volumes:
  spindb-data:
`
}

/**
 * 生成 .env 文件内容
 */
function generateEnvFile(
  containerName: string,
  engine: Engine,
  version: string,
  port: number,
  database: string,
  credentials: Credentials,
): string {
  return `# SpinDB Docker 配置
# 由 spindb export docker 生成

# 容器设置
CONTAINER_NAME=${containerName}
ENGINE=${engine}
VERSION=${version}
PORT=${port}
DATABASE=${database}

# 凭据（自动生成，生产环境请修改）
SPINDB_USER=${credentials.username}
SPINDB_PASSWORD=${credentials.password}
`
}

/**
 * 生成 README.md 内容
 */
function generateReadme(
  containerName: string,
  engine: Engine,
  version: string,
  port: number,
  database: string,
  useTLS: boolean,
): string {
  const displayName = getEngineDisplayName(engine)
  const connectionTemplate = getConnectionStringTemplate(
    engine,
    port,
    database,
    useTLS,
  )

  // TLS 条件内容
  const tlsSecurityNote = useTLS
    ? '- `certs/` 中的 TLS 证书是自签名的。生产环境请替换为有效证书。'
    : '- 此导出已禁用 TLS。生产环境建议启用 TLS。'
  const certsFileEntry = useTLS ? '| `certs/` | TLS 证书 |\n' : ''
  const tlsCustomization = useTLS
    ? `
### 使用自定义证书

替换 \`certs/\` 中的文件：
- \`server.crt\` - TLS 证书
- \`server.key\` - TLS 私钥

### 禁用 TLS

编辑 \`entrypoint.sh\` 并移除 TLS 相关标志（不建议在生产环境中使用）。
`
    : `
### 启用 TLS

重新导出容器时不使用 \`--skip-tls\` 标志即可启用 TLS（需要 OpenSSL）。
`

  return `# ${containerName} - SpinDB Docker 导出

此目录包含用于运行 SpinDB ${displayName} 容器的 Docker 就绪包。

## 快速开始

\`\`\`bash
# 启动容器
docker compose up -d

# 查看日志
docker compose logs -f

# 停止容器
docker compose down
\`\`\`

## 配置

| 设置 | 值 |
|------|-----|
| 引擎 | ${displayName} ${version} |
| 端口 | ${port} |
| 数据库 | ${database} |
| 用户名 | spindb |

## 连接字符串

\`\`\`
${connectionTemplate}
\`\`\`

将 \`<host>\` 替换为你的服务器主机名或 IP 地址。
将 \`\${SPINDB_USER}\` 和 \`\${SPINDB_PASSWORD}\` 替换为 \`.env\` 中的值。

## 安全说明

- \`.env\` 文件包含自动生成的凭据。**生产环境中请修改这些凭据。**
${tlsSecurityNote}
- 默认的 \`spindb\` 用户拥有数据库的完全访问权限。请为应用程序创建受限用户。

## 文件

| 文件 | 描述 |
|------|------|
| \`Dockerfile\` | Docker 镜像定义 |
| \`docker-compose.yml\` | 容器编排 |
| \`.env\` | 环境变量和凭据 |
| \`entrypoint.sh\` | 容器启动脚本 |
${certsFileEntry}| \`data/\` | 初始化用数据库备份 |

## 自定义

### 修改端口

编辑 \`.env\`：
\`\`\`
PORT=5433
\`\`\`
${tlsCustomization}
---

由 [SpinDB](https://github.com/robertjbass/spindb) 生成
`
}

/**
 * 将 SpinDB 容器导出为 Docker 就绪的构件
 */
export async function exportToDocker(
  container: ContainerConfig,
  options: DockerExportOptions,
): Promise<DockerExportResult> {
  const {
    outputDir,
    port = container.port,
    includeData = true,
    backupPath,
    backupPaths,
    skipTLS = false,
  } = options

  const engine = container.engine
  const version = container.version
  const database = container.database
  const containerName = container.name
  // 获取容器的所有数据库
  const databases = container.databases || [database]

  return withTransaction(async (tx) => {
    // 检查输出目录是否已存在
    const outputDirExisted = existsSync(outputDir)

    if (outputDirExisted) {
      // 如果已存在，检查是否为空或仅包含 'data'（来自备份步骤）
      const existingFiles = await readdir(outputDir)
      const nonDataFiles = existingFiles.filter((f) => f !== 'data')
      if (nonDataFiles.length > 0) {
        throw new Error(
          `输出目录 "${outputDir}" 已存在且不为空。` +
            `请使用空目录或删除现有文件。`,
        )
      }
      // 目录存在但为空或仅有 data/ - 不为其注册回滚
    } else {
      // 目录不存在 - 创建并注册回滚
      await mkdir(outputDir, { recursive: true })
      tx.addRollback({
        description: `删除输出目录: ${outputDir}`,
        execute: async () => {
          await rm(outputDir, { recursive: true, force: true })
        },
      })
    }

    // 创建子目录（始终注册回滚，因为是我们创建的）
    const certsDir = join(outputDir, 'certs')
    const dataDir = join(outputDir, 'data')

    await mkdir(certsDir, { recursive: true })
    tx.addRollback({
      description: `删除证书目录: ${certsDir}`,
      execute: async () => {
        await rm(certsDir, { recursive: true, force: true })
      },
    })

    await mkdir(dataDir, { recursive: true })
    tx.addRollback({
      description: `删除数据目录: ${dataDir}`,
      execute: async () => {
        await rm(dataDir, { recursive: true, force: true })
      },
    })

    const files: string[] = []

    // 生成凭据
    const credentials = generateCredentials()

    // 检查 OpenSSL 可用性，用于 TLS 决策
    const hasOpenSSL = await isOpenSSLAvailable()

    // 生成 TLS 证书（如果 openssl 可用且未跳过）
    if (!skipTLS && hasOpenSSL) {
      await generateTLSCertificates({
        outputDir: join(outputDir, 'certs'),
        commonName: 'localhost',
        validDays: 365,
      })
      files.push('certs/server.crt', 'certs/server.key')
    }

    // 如果提供了备份文件则复制（多数据库）
    if (includeData && backupPaths && backupPaths.length > 0) {
      for (const bp of backupPaths) {
        if (existsSync(bp.path)) {
          const backupFilename = basename(bp.path)
          await copyFile(bp.path, join(outputDir, 'data', backupFilename))
          files.push(`data/${backupFilename}`)
        }
      }
    } else if (includeData && backupPath && existsSync(backupPath)) {
      // 单个备份文件（旧版兼容）
      const backupFilename = basename(backupPath)
      await copyFile(backupPath, join(outputDir, 'data', backupFilename))
      files.push(`data/${backupFilename}`)
    }

    // 确定 Dockerfile 和 entrypoint 的 TLS 状态
    const useTLS = !skipTLS && hasOpenSSL

    // 生成 Dockerfile
    const dockerfile = generateDockerfile(
      engine,
      isFileBasedEngine(engine),
      useTLS,
    )
    await writeFile(join(outputDir, 'Dockerfile'), dockerfile)
    files.push('Dockerfile')

    // 生成 entrypoint.sh
    const entrypoint = generateEntrypoint(
      engine,
      containerName,
      database,
      databases,
      version,
      port,
      useTLS,
    )
    await writeFile(join(outputDir, 'entrypoint.sh'), entrypoint, {
      mode: 0o755,
    })
    files.push('entrypoint.sh')

    // 生成 docker-compose.yml
    const dockerCompose = generateDockerCompose(
      containerName,
      engine,
      version,
      port,
      database,
      isFileBasedEngine(engine),
    )
    await writeFile(join(outputDir, 'docker-compose.yml'), dockerCompose)
    files.push('docker-compose.yml')

    // 生成 .env 文件
    const envFile = generateEnvFile(
      containerName,
      engine,
      version,
      port,
      database,
      credentials,
    )
    await writeFile(join(outputDir, '.env'), envFile)
    files.push('.env')

    // 生成 README.md
    const readme = generateReadme(
      containerName,
      engine,
      version,
      port,
      database,
      useTLS,
    )
    await writeFile(join(outputDir, 'README.md'), readme)
    files.push('README.md')

    return {
      outputDir,
      credentials,
      port,
      engine,
      version,
      database,
      files,
    }
  })
}

/**
 * 获取容器导出将使用的备份文件路径
 */
export function getExportBackupPath(
  outputDir: string,
  containerName: string,
  database: string,
  engine: Engine,
): string {
  const format = getDefaultFormat(engine)
  const extension = getBackupExtension(engine, format)
  return join(outputDir, 'data', `${containerName}-${database}${extension}`)
}

/**
 * 获取容器的默认 Docker 导出目录
 */
export function getDefaultDockerExportPath(
  containerName: string,
  engine: Engine,
): string {
  return join(
    homedir(),
    '.spindb',
    'containers',
    engine,
    containerName,
    'docker',
  )
}

/**
 * 检查容器的 Docker 导出是否已存在
 */
export function dockerExportExists(
  containerName: string,
  engine: Engine,
): boolean {
  const exportPath = getDefaultDockerExportPath(containerName, engine)
  const envPath = join(exportPath, '.env')
  return existsSync(envPath)
}

export type DockerCredentials = {
  username: string
  password: string
  port: number
  database: string
  engine: string
  version: string
  containerName: string
}

/**
 * 从现有导出的 .env 文件读取 Docker 凭据
 */
export async function getDockerCredentials(
  containerName: string,
  engine: Engine,
): Promise<DockerCredentials | null> {
  const exportPath = getDefaultDockerExportPath(containerName, engine)
  const envPath = join(exportPath, '.env')

  if (!existsSync(envPath)) {
    return null
  }

  try {
    const envContent = await readFile(envPath, 'utf-8')
    const lines = envContent.split('\n')

    const values: Record<string, string> = {}
    for (const line of lines) {
      const match = line.match(/^([A-Z_]+)=(.*)$/)
      if (match) {
        values[match[1]] = match[2]
      }
    }

    return {
      username: values.SPINDB_USER || 'spindb',
      password: values.SPINDB_PASSWORD || '',
      port: parseInt(values.PORT || '0', 10),
      database: values.DATABASE || '',
      engine: values.ENGINE || engine,
      version: values.VERSION || '',
      containerName: values.CONTAINER_NAME || containerName,
    }
  } catch {
    return null
  }
}

/**
 * 获取现有导出的 Docker 连接字符串
 * 返回替换了实际凭据的连接字符串
 */
export async function getDockerConnectionString(
  containerName: string,
  engine: Engine,
  options: { host?: string } = {},
): Promise<string | null> {
  const credentials = await getDockerCredentials(containerName, engine)
  if (!credentials) {
    return null
  }

  const host = options.host || 'localhost'
  const { username, password, port, database } = credentials

  // 对凭据进行 URL 编码以转义保留的 URI 字符
  const encodedUsername = encodeURIComponent(username)
  const encodedPassword = encodeURIComponent(password)
  const encodedDatabase = encodeURIComponent(database)

  // 根据引擎类型构建连接字符串
  switch (engine) {
    case Engine.PostgreSQL:
    case Engine.CockroachDB:
    case Engine.QuestDB:
      return `postgresql://${encodedUsername}:${encodedPassword}@${host}:${port}/${encodedDatabase}`

    case Engine.MySQL:
    case Engine.MariaDB:
      return `mysql://${encodedUsername}:${encodedPassword}@${host}:${port}/${encodedDatabase}`

    case Engine.MongoDB:
    case Engine.FerretDB:
      return `mongodb://${encodedUsername}:${encodedPassword}@${host}:${port}/${encodedDatabase}`

    case Engine.Redis:
    case Engine.Valkey:
      return `redis://:${encodedPassword}@${host}:${port}`

    case Engine.ClickHouse:
      return `clickhouse://${encodedUsername}:${encodedPassword}@${host}:${port}/${encodedDatabase}`

    case Engine.Qdrant:
      return `http://${host}:${port}`

    case Engine.Meilisearch:
    case Engine.InfluxDB:
    case Engine.Weaviate:
    case Engine.LibSQL:
      return `http://${host}:${port}`

    case Engine.CouchDB:
      return `http://${username}:${password}@${host}:${port}/${database}`

    case Engine.SurrealDB:
      return `ws://${username}:${password}@${host}:${port}`

    case Engine.TypeDB:
      return `typedb://${host}:${port}`

    case Engine.TigerBeetle:
      return `${host}:${port}`

    case Engine.SQLite:
    case Engine.DuckDB:
      return `基于文件的数据库（无网络连接）`

    default:
      assertExhaustive(
        engine,
        `getDockerConnectionString 中未处理的引擎: ${engine}`,
      )
  }
}
