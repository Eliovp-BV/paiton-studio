import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const root = path.dirname(fileURLToPath(import.meta.url));

// Record the build identity for studio/version.py; VERSION stays the only
// place the version number is written.
function buildInfo() {
  return {
    name: "paiton-build-info",
    apply: "build",
    buildStart() {
      const record = path.join(root, "studio/build_info.json");
      let gitSha = "unknown";
      if (!existsSync(path.join(root, ".git"))) {
        // A source ZIP carries the packaged revision; a rebuild keeps it.
        try {
          gitSha =
            JSON.parse(readFileSync(record, "utf8")).git_sha || "unknown";
        } catch {
          gitSha = "unknown";
        }
      } else {
        try {
          gitSha =
            execSync("git rev-parse --short HEAD", {
              cwd: root,
              stdio: ["ignore", "pipe", "ignore"],
            })
              .toString()
              .trim() || "unknown";
        } catch {
          gitSha = "unknown";
        }
      }
      const info = {
        version: readFileSync(path.join(root, "VERSION"), "utf8").trim(),
        git_sha: gitSha,
        built_at: new Date().toISOString(),
      };
      writeFileSync(record, JSON.stringify(info, null, 2) + "\n");
    },
  };
}

export default defineConfig({
  plugins: [react(), buildInfo()],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8877",
      "/v1": "http://127.0.0.1:8877",
    },
  },
  build: { outDir: "dist" },
});
