import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePostgreSQLError, PostgreSQLStorage, StorageUnavailableError } from '../server/storage.js';

test('PostgreSQL connection failures become safe retryable 503 errors without credential details', () => {
  const secret = 'postgres://private-user:private-password@example.invalid/private-db';
  for (const code of ['08000', '08001', '08003', '08006', '08P01', '57P01', '57P02', '57P03', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND']) {
    const value = normalizePostgreSQLError(Object.assign(new Error(secret), { code }));
    assert.ok(value instanceof StorageUnavailableError); assert.equal(value.statusCode, 503);
    assert.equal(String(value).includes('private-'), false); assert.equal(JSON.stringify(value).includes('private-'), false);
    assert.equal('cause' in value, false);
  }
  for (const message of ['Connection terminated unexpectedly', 'Connection terminated due to connection timeout', 'terminating connection due to administrator command', 'timeout exceeded when trying to connect', 'Client has encountered a connection error and is not queryable']) {
    assert.ok(normalizePostgreSQLError(new Error(message)) instanceof StorageUnavailableError);
  }
  assert.ok(normalizePostgreSQLError(new AggregateError([Object.assign(new Error(secret), { code: 'ECONNREFUSED' })])) instanceof StorageUnavailableError);
});

test('SQL validation, permission, authentication and application failures are not converted into temporary outages', () => {
  for (const code of ['23505', '23503', '42601', '42501', '28P01', '3D000', '57014']) {
    const error = Object.assign(new Error('Connection terminated'), { code });
    assert.equal(normalizePostgreSQLError(error), error);
  }
  const validation = new Error('服务资料无效');
  assert.equal(normalizePostgreSQLError(validation), validation);
});

test('PostgreSQL initialization connection failures return safe 503 errors', async () => {
  const storage = new PostgreSQLStorage('postgres://fixture:private-fixture@127.0.0.1:1/unavailable');
  try {
    await assert.rejects(storage.ready(), (error: unknown) => error instanceof StorageUnavailableError && error.statusCode === 503 && !String(error).includes('private-fixture'));
    await assert.rejects(storage.all('SELECT 1'), StorageUnavailableError);
    await assert.rejects(storage.transaction(() => undefined), StorageUnavailableError);
  } finally { await storage.close(); }
});
