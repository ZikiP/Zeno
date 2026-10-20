import { parentPort, workerData } from 'node:worker_threads';
import { listChapters } from './chapter-parse.mjs';

try {
  parentPort.postMessage({ ok: true, list: listChapters(workerData.html, workerData.parse) });
} catch (e) {
  parentPort.postMessage({ ok: false, error: String(e?.message ?? e) });
}
