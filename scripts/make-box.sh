#!/bin/bash
# Builds the Ember program package for the laser box: ember-box-<version>.tar.gz (+ .sha256).
# Run it on the same kind of computer as the box (arm64 Linux), e.g. GitHub's ubuntu-24.04-arm runner.
set -euo pipefail
cd "$(dirname "$0")/.."
V="$(tr -d '\r\n' < VERSION)"
OUT="${1:-out}"
rm -rf "$OUT/ember-box"; mkdir -p "$OUT/ember-box"
npm run build
cp -r dist "$OUT/ember-box/dist"
echo "$V" > "$OUT/ember-box/VERSION"
# Only what the server needs at run time (the screen is already bundled into dist/renderer).
node -e '
const p=require("./package.json");
const keep=["ws","serialport","bonjour-service"];
const dependencies={}; for(const k of keep){ if(!p.dependencies[k]) throw new Error("missing dependency "+k); dependencies[k]=p.dependencies[k]; }
require("fs").writeFileSync(process.argv[1], JSON.stringify({name:"ember-box",version:p.version,private:true,dependencies},null,1));
' "$OUT/ember-box/package.json"
(cd "$OUT/ember-box" && npm install --omit=dev --no-audit --no-fund)
(cd "$OUT" && tar -czf "ember-box-$V.tar.gz" ember-box && sha256sum "ember-box-$V.tar.gz" > "ember-box-$V.tar.gz.sha256")
ls -lh "$OUT"/ember-box-*
