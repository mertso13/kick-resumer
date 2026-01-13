const fs = require("fs");
const path = require("path");

const SRC_DIR = path.join(__dirname, "..", "src");
const MANIFESTS_DIR = path.join(__dirname, "..", "manifests");
const DIST_DIR = path.join(__dirname, "..", "dist");

function cleanDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
}

function copyRecursiveSync(src, dest) {
  const exists = fs.existsSync(src);
  const stats = exists && fs.statSync(src);
  const isDirectory = exists && stats.isDirectory();
  if (isDirectory) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest);
    }
    fs.readdirSync(src).forEach((childItemName) => {
      copyRecursiveSync(
        path.join(src, childItemName),
        path.join(dest, childItemName)
      );
    });
  } else {
    fs.copyFileSync(src, dest);
  }
}

function build(target) {
  console.log(`Building target: ${target}...`);
  const targetDir = path.join(DIST_DIR, target);

  cleanDir(targetDir);

  copyRecursiveSync(SRC_DIR, targetDir);

  const rootDir = path.join(__dirname, "..");
  ["LICENSE", "README.md"].forEach((file) => {
    const filePath = path.join(rootDir, file);
    if (fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, path.join(targetDir, file));
    }
  });

  const commonManifest = JSON.parse(
    fs.readFileSync(path.join(MANIFESTS_DIR, "common.json"), "utf8")
  );
  const targetManifest = JSON.parse(
    fs.readFileSync(path.join(MANIFESTS_DIR, `${target}.json`), "utf8")
  );

  const finalManifest = { ...commonManifest, ...targetManifest };

  if (commonManifest.content_scripts && targetManifest.content_scripts) {
    finalManifest.content_scripts = commonManifest.content_scripts.map(
      (cs, index) => {
        const targetCs = targetManifest.content_scripts[index] || {};
        return { ...cs, ...targetCs };
      }
    );
  }

  fs.writeFileSync(
    path.join(targetDir, "manifest.json"),
    JSON.stringify(finalManifest, null, 2)
  );
  console.log(`Successfully built ${target} at ${targetDir}`);
}

cleanDir(DIST_DIR);

build("firefox");

build("chrome");
