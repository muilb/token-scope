// Bundles every *.test.ts under src/ to CJS (via esbuild) then runs node --test.
// Keeps the project dependency-free: no ts-node/tsx/jest, just esbuild + node:test.
const esbuild = require("esbuild");
const { globSync } = require("fs");
const { spawnSync } = require("child_process");
const os = require("os");
const path = require("path");
const fs = require("fs");

async function main() {
  const entryPoints = globSync("src/**/*.test.ts");
  if (!entryPoints.length) {
    console.log("no *.test.ts found");
    return;
  }
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenscope-test-"));
  await esbuild.build({
    entryPoints,
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node18",
    outdir,
    external: ["vscode"],
  });
  const built = globSync(path.join(outdir, "**/*.js"));
  const res = spawnSync(process.execPath, ["--test", ...built], { stdio: "inherit" });
  fs.rmSync(outdir, { recursive: true, force: true });
  process.exit(res.status ?? 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
