/**
 * SQLite 扫描器 — 对共享的 file-based-utils 的薄封装
 */

import { Engine } from '../../types'
import {
  scanForUnregisteredFiles,
  deriveContainerName as sharedDeriveContainerName,
  type UnregisteredFile,
} from '../file-based-utils'

export type { UnregisteredFile }

export async function scanForUnregisteredSqliteFiles(
  directory?: string,
): Promise<UnregisteredFile[]> {
  return scanForUnregisteredFiles(Engine.SQLite, directory)
}

export function deriveContainerName(fileName: string): string {
  return sharedDeriveContainerName(fileName, Engine.SQLite)
}