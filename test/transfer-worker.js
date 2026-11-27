import { parentPort, workerData } from 'node:worker_threads';

process.env.DATABASE_PATH = workerData.dbPath;
process.env.NODE_ENV = 'test';

const { createTransfer } = await import('../src/services/transfers.js');

try {
  const result = createTransfer(workerData.userId, workerData.input);
  parentPort.postMessage({ ok: true, duplicate: result.duplicate, id: result.transfer.id });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    message: error.message,
    status: error.status ?? 500,
  });
}
