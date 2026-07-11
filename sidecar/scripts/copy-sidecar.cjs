const {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
} = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const sidecarDirectory = path.resolve(__dirname, "..");
const projectRoot = path.resolve(sidecarDirectory, "..");

const extension = process.platform === "win32" ? ".exe" : "";

const sourceBinary = path.join(
  sidecarDirectory,
  `ssh-sidecar${extension}`,
);

const targetTriple = execFileSync(
  "rustc",
  ["--print", "host-tuple"],
  {
    encoding: "utf8",
  },
).trim();

if (!targetTriple) {
  throw new Error("Unable to determine the Rust host target.");
}

if (!existsSync(sourceBinary)) {
  throw new Error(`Sidecar binary was not found: ${sourceBinary}`);
}

const targetDirectory = path.join(
  projectRoot,
  "src-tauri",
  "binaries",
);

mkdirSync(targetDirectory, {
  recursive: true,
});

const targetBinary = path.join(
  targetDirectory,
  `ssh-sidecar-${targetTriple}${extension}`,
);

copyFileSync(sourceBinary, targetBinary);
rmSync(sourceBinary);

console.log(`Sidecar copied to:\n${targetBinary}`);
