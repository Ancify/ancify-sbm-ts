// Tiny test runner used when vitest cannot be installed (e.g. sandboxed
// environments where the registry TLS chain can't be validated). The
// API is intentionally a subset of vitest so we can switch over by
// flipping the imports once vitest is available.
//
// Usage: `npx ts-node test/all.ts` (or `yarn test`).

import { strict as assert } from "node:assert";

type TestFn = () => Promise<void> | void;
interface Test { name: string; fn: TestFn; suite: string | null; }

const tests: Test[] = [];
let currentSuite: string | null = null;

export function describe(name: string, fn: () => void): void {
  const previous = currentSuite;
  currentSuite = previous ? `${previous} > ${name}` : name;
  try {
    fn();
  } finally {
    currentSuite = previous;
  }
}

export function test(name: string, fn: TestFn): void {
  tests.push({ name, fn, suite: currentSuite });
}

export { assert };

export async function runAll(): Promise<void> {
  let passed = 0;
  let failed = 0;
  const failures: { fullName: string; err: unknown }[] = [];
  const started = Date.now();

  let lastSuite: string | null = null;
  for (const t of tests) {
    if (t.suite !== lastSuite) {
      if (t.suite) console.log(t.suite);
      lastSuite = t.suite;
    }
    const fullName = t.suite ? `${t.suite} > ${t.name}` : t.name;
    const tStart = Date.now();
    try {
      await withTimeout(t.fn(), 10000, fullName);
      const ms = Date.now() - tStart;
      console.log(`  ok   ${t.name} (${ms}ms)`);
      passed++;
    } catch (err) {
      const ms = Date.now() - tStart;
      console.log(`  FAIL ${t.name} (${ms}ms)`);
      failures.push({ fullName, err });
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
      console.log(`  - ${f.fullName}`);
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
