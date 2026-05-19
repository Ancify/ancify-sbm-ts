// Tiny test runner used when vitest cannot be installed (e.g. sandboxed
// environments where the registry TLS chain can't be validated). The
// API is intentionally a subset of vitest so we can switch over by
// flipping the imports once vitest is available.
//
// Usage: `npx ts-node test/all.ts` (or `yarn test`).

import { strict as assert } from "node:assert";

type TestFn = () => Promise<void> | void;
interface Test { name: string; fn: TestFn; }

const tests: Test[] = [];

export function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

export { assert };

export async function runAll(): Promise<void> {
  let passed = 0;
  let failed = 0;
  const failures: { name: string; err: unknown }[] = [];
  const started = Date.now();

  for (const t of tests) {
    const tStart = Date.now();
    try {
      // 8s default — most tests finish in <200ms but the reconnect
      // regression has to wait through real socket close + reconnect.
      await withTimeout(t.fn(), 8000, t.name);
      const ms = Date.now() - tStart;
      console.log(`  ok   ${t.name} (${ms}ms)`);
      passed++;
    } catch (err) {
      const ms = Date.now() - tStart;
      console.log(`  FAIL ${t.name} (${ms}ms)`);
      failures.push({ name: t.name, err });
      failed++;
    }
  }

  const totalMs = Date.now() - started;
  console.log("");
  console.log(`${passed}/${tests.length} passed in ${totalMs}ms`);

  if (failed > 0) {
    console.log("");
    console.log("Failures:");
    for (const f of failures) {
      console.log(`  - ${f.name}`);
      console.log(`    ${formatError(f.err)}`);
    }
    process.exit(1);
  }
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return (err.stack ?? err.message).split("\n").join("\n    ");
  }
  return String(err);
}

async function withTimeout<T>(p: Promise<T> | T, ms: number, name: string): Promise<T> {
  if (!(p instanceof Promise)) return p;
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Test '${name}' timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
