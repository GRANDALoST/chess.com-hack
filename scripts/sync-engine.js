// Refreshes the bundled Stockfish engine files in engine/ from the
// `stockfish` npm package. Run with: npm run sync-engine
"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const VERSION = "19.0.1";
const TGZ = `stockfish-${VERSION}.tgz`;
const WANTED = [
  "package/bin/stockfish-19-lite-single.js",
  "package/bin/stockfish-19-lite-single.wasm",
];

const root = path.resolve(__dirname, "..");
const engineDir = path.join(root, "engine");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chesscheat-engine-"));

try {
  console.log(`Packing stockfish@${VERSION}...`);
  execFileSync("npm", ["pack", `stockfish@${VERSION}`], { cwd: tmp, stdio: "inherit" });

  console.log("Extracting engine files...");
  execFileSync("tar", ["-xzf", TGZ, ...WANTED], { cwd: tmp, stdio: "inherit" });

  fs.mkdirSync(engineDir, { recursive: true });
  for (const rel of WANTED) {
    const src = path.join(tmp, rel);
    const dest = path.join(engineDir, path.basename(rel));
    fs.copyFileSync(src, dest);
    console.log(`  ${path.basename(rel)}`);
  }
  console.log("Done. Reload the extension in chrome://extensions.");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
