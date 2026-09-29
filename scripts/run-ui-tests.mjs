import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const requested = process.argv.slice(2);
const suites = (await readdir("tests"))
  .filter((name) => /^browser(?:_.*)?\.mjs$/.test(name))
  .filter((name) => name !== "browser_support.mjs")
  .filter(
    (name) =>
      !requested.length ||
      requested.some(
        (filter) =>
          name === path.basename(filter) || name === `browser_${filter}.mjs`,
      ),
  )
  .sort();
if (!suites.length) throw new Error("No browser suites matched.");
await mkdir(path.join(root, ".local", "ui-tests"), { recursive: true });
const run = await mkdtemp(path.join(root, ".local", "ui-tests", "run-"));
const python =
  process.env.STUDIO_PYTHON ||
  path.join(
    root,
    ".venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
const libraries = path.join(
  root,
  ".local/browser-libs/root/usr/lib/x86_64-linux-gnu",
);
const env = { ...process.env, STUDIO_PYTHON: python, STUDIO_UI_HARNESS: "1" };
if (existsSync(libraries))
  env.LD_LIBRARY_PATH = [libraries, env.LD_LIBRARY_PATH]
    .filter(Boolean)
    .join(path.delimiter);
const children = new Set();
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    interrupted = true;
    for (const child of children) child.kill("SIGTERM");
  });
async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function launch(command, args, options, log) {
  const output = createWriteStream(log);
  const child = spawn(command, args, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  children.add(child);
  child.stdout.pipe(output);
  child.stderr.pipe(output);
  child.on("close", () => {
    children.delete(child);
    output.end();
  });
  return child;
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
  await closed;
  clearTimeout(timer);
}
const results = [];
console.log(`CPU-only browser fixtures; artifacts: ${run}`);
for (const suite of suites) {
  if (interrupted) break;
  const directory = path.join(run, suite.replace(/\.mjs$/, ""));
  await mkdir(directory);
  const data = path.join(directory, "data");
  await mkdir(data);
  const backendPort = await freePort();
  let vite, backend, test;
  const started = Date.now();
  const log = path.join(directory, "suite.log");
  try {
    const target = `http://127.0.0.1:${backendPort}`;
    vite = await createServer({
      root,
      configFile: false,
      plugins: [react()],
      logLevel: "error",
      cacheDir: path.join(root, "node_modules/.vite-ui"),
      optimizeDeps: { entries: ["index.html"] },
      server: {
        host: "127.0.0.1",
        port: await freePort(),
        strictPort: true,
        watch: { ignored: ["**/*"] },
        proxy: Object.fromEntries(
          ["/api", "/v1", "/mcp", "/comfy"].map((prefix) => [
            prefix,
            { target, changeOrigin: false },
          ]),
        ),
      },
    });
    await vite.listen();
    const port = vite.httpServer.address().port;
    const base = `http://127.0.0.1:${port}`;
    const fixtureEnv = {
      ...env,
      PAITON_STUDIO_PORT: String(port),
      STUDIO_TEST_BACKEND_PORT: String(backendPort),
      STUDIO_TEST_DATA: data,
      STUDIO_URL: base,
      STUDIO_TEST_URL: base,
      STUDIO_CAPTURE_DIR: directory,
    };
    backend = launch(
      python,
      ["tests/ui_backend.py"],
      { env: fixtureEnv },
      path.join(directory, "backend.log"),
    );
    for (let attempt = 0; ; attempt++) {
      if (backend.exitCode !== null)
        throw new Error("Fixture backend exited; see backend.log");
      try {
        if (
          existsSync(path.join(data, "fixture.json")) &&
          (await fetch(`${base}/api/session`)).ok
        )
          break;
      } catch {}
      if (attempt >= 100)
        throw new Error("Fixture backend did not become ready.");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const fixture = JSON.parse(
      await readFile(path.join(data, "fixture.json"), "utf8"),
    );
    test = launch(
      process.execPath,
      [path.join("tests", suite)],
      {
        env: {
          ...fixtureEnv,
          STUDIO_PROJECT: fixture.project,
          STUDIO_TEST_IMAGE: fixture.image,
        },
      },
      log,
    );
    const timer = setTimeout(
      () => test.kill("SIGTERM"),
      Number(process.env.STUDIO_UI_TIMEOUT_MS || 180000),
    );
    let code, signal;
    try {
      [code, signal] = await once(test, "close");
    } finally {
      clearTimeout(timer);
    }
    if (code !== 0) throw new Error(`Suite exited ${code ?? signal}`);
    results.push({
      suite,
      passed: true,
      seconds: (Date.now() - started) / 1000,
    });
    console.log(`PASS ${suite} (${results.at(-1).seconds.toFixed(1)}s)`);
  } catch (error) {
    results.push({
      suite,
      passed: false,
      error: error.message,
      seconds: (Date.now() - started) / 1000,
    });
    console.error(`FAIL ${suite}: ${error.message}\n  ${log}`);
    if (existsSync(log))
      console.error((await readFile(log, "utf8")).slice(-3500));
  } finally {
    await stop(test);
    await stop(backend);
    await vite?.close();
  }
}
await writeFile(
  path.join(run, "results.json"),
  JSON.stringify(results, null, 2) + "\n",
);
const passed = results.filter((result) => result.passed).length;
console.log(
  `${passed}/${suites.length} browser suites passed; ${results.length - passed} failed.`,
);
process.exitCode = interrupted || passed !== suites.length ? 1 : 0;
