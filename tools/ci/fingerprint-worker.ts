// Computes byakugan fingerprints for tasks.ts on a worker thread.
import { parentPort } from "node:worker_threads";
import { analyze } from "byakugan-cli";

parentPort!.on("message", ({ id, cwd, config }) => {
  try {
    const graph = analyze({ cwd, config });
    parentPort!.postMessage({ id, fingerprint: graph.fingerprint(), warnings: graph.warnings });
  } catch (error) {
    parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
