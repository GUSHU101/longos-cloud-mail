import {lstatSync, readFileSync} from 'node:fs';
import {isAbsolute} from 'node:path';

const MAX_SECRET_BYTES = 8192;

export function readSecret(name, environment = process.env) {
  const directValue = String(environment[name] || '');
  const fileVariable = `${name}_FILE`;
  const filePath = String(environment[fileVariable] || '').trim();

  if (directValue && filePath) {
    throw new Error(`${name} and ${fileVariable} cannot both be configured`);
  }
  if (!filePath) return directValue;
  if (!isAbsolute(filePath)) {
    throw new Error(`${fileVariable} must be an absolute path`);
  }

  const metadata = lstatSync(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${fileVariable} must reference a regular file`);
  }
  if (metadata.size === 0 || metadata.size > MAX_SECRET_BYTES) {
    throw new Error(`${fileVariable} must contain between 1 and ${MAX_SECRET_BYTES} bytes`);
  }

  const value = readFileSync(filePath, 'utf8').replace(/\r?\n$/, '');
  if (!value || /[\0\r\n]/.test(value)) {
    throw new Error(`${fileVariable} must contain exactly one non-empty text line`);
  }
  return value;
}
