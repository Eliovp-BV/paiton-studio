// Run both Node unit-test filename conventions, stopping at the first failure.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tests = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../tests",
);
const files = readdirSync(tests)
  .filter((name) => name.endsWith(".test.mjs") || /^test_.*\.mjs$/.test(name))
  .sort();
for (const name of files) {
  const result = spawnSync(process.execPath, [path.join(tests, name)], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error(`FAIL ${name}`);
    process.exit(result.status ?? 1);
  }
}
console.log(`${files.length} node unit test files passed`);
