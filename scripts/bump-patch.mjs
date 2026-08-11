import fs from "node:fs";

const readJson = (path) => JSON.parse(fs.readFileSync(path, "utf8"));
const writeJson = (path, value) =>
  fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

const pkg = readJson("package.json");
const parts = pkg.version.split(".").map(Number);
if (parts.length !== 3 || parts.some(Number.isNaN)) {
  throw new Error(`Invalid app version: ${pkg.version}`);
}

const previousVersion = pkg.version;
const version = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;

pkg.version = version;
writeJson("package.json", pkg);

const tauri = readJson("src-tauri/tauri.conf.json");
if (tauri.version !== previousVersion) {
  throw new Error(
    `Version mismatch: package.json=${previousVersion}, src-tauri/tauri.conf.json=${tauri.version}`,
  );
}
tauri.version = version;
writeJson("src-tauri/tauri.conf.json", tauri);

const cargoManifestPath = "Cargo.toml";
const cargoManifest = fs.readFileSync(cargoManifestPath, "utf8");
const workspaceVersion = cargoManifest.match(
  /^(\[workspace\.package\][\s\S]*?^version\s*=\s*)"([^"]+)"/m,
);
if (!workspaceVersion) {
  throw new Error("Could not find [workspace.package] version in Cargo.toml");
}
if (workspaceVersion[2] !== previousVersion) {
  throw new Error(
    `Version mismatch: package.json=${previousVersion}, Cargo.toml=${workspaceVersion[2]}`,
  );
}
fs.writeFileSync(
  cargoManifestPath,
  cargoManifest.replace(workspaceVersion[0], `${workspaceVersion[1]}"${version}"`),
);

const cargoLockPath = "Cargo.lock";
const cargoLock = fs.readFileSync(cargoLockPath, "utf8");
let updatedPackages = 0;
const updatedCargoLock = cargoLock.replace(
  /\[\[package\]\]\n[\s\S]*?(?=\n\[\[package\]\]|$)/g,
  (block) => {
    // Workspace packages have no registry `source`. Keep independently
    // versioned local crates (for example ghostty-sys 0.0.1) untouched.
    if (block.includes("\nsource = ") || !block.includes(`\nversion = "${previousVersion}"`)) {
      return block;
    }
    updatedPackages += 1;
    return block.replace(
      `\nversion = "${previousVersion}"`,
      `\nversion = "${version}"`,
    );
  },
);
if (updatedPackages === 0) {
  throw new Error(`No local Cargo.lock packages found at version ${previousVersion}`);
}
fs.writeFileSync(cargoLockPath, updatedCargoLock);

process.stdout.write(`${version}\n`);
