import { chromium as playwrightChromium } from "playwright";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function executable() {
  if (process.env.STUDIO_CHROMIUM) return process.env.STUDIO_CHROMIUM;
  if (existsSync(playwrightChromium.executablePath()))
    return playwrightChromium.executablePath();
  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
    path.join(os.homedir(), ".cache", "ms-playwright");
  if (process.platform === "linux" && existsSync(cache)) {
    for (const folder of readdirSync(cache)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort()
      .reverse()) {
      for (const relative of ["chrome-linux64/chrome", "chrome-linux/chrome"]) {
        const binary = path.join(cache, folder, relative);
        if (existsSync(binary)) return binary;
      }
    }
  }
  return undefined;
}

export const chromium = {
  launch(options = {}) {
    if (process.env.STUDIO_UI_HARNESS !== "1") {
      throw new Error(
        "Run browser checks through npm run test:ui so they use disposable fixtures.",
      );
    }
    for (const key of ["STUDIO_URL", "STUDIO_TEST_URL"]) {
      const url = new URL(process.env[key]);
      if (url.hostname !== "127.0.0.1" || url.port === "8877")
        throw new Error("Browser checks require an isolated loopback server.");
    }
    return playwrightChromium.launch({
      ...options,
      executablePath: options.executablePath || executable(),
      args: [...(options.args || []), "--disable-gpu"],
      headless: true,
    });
  },
};
