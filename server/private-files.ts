import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/** Refuse redirected locations; credentials must remain under the selected data directory. */
export function privateDirectory(path: string): string {
  const directory = resolve(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('数据目录必须是普通目录');
  chmodSync(directory, 0o700);
  return directory;
}
export function privateFile(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('数据文件必须是普通文件');
  chmodSync(path, 0o600);
}
