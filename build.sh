#!/bin/sh
# Builds everything into dist/: the extension package and the helper for each platform.
set -e
cd "$(dirname "$0")"
rm -rf dist && mkdir dist
v=$(sed -n 's/.*"version": "\(.*\)".*/\1/p' extension/manifest.json)
(cd extension && zip -qr -X "../dist/reaper-$v.xpi" .)
b() { (cd host && GOOS=$1 GOARCH=$2 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o "../dist/$3" .); }
b windows amd64 "Reaper.Setup.exe"
b linux   amd64 reaper-helper-linux-x64
b linux   arm64 reaper-helper-linux-arm64
b darwin  amd64 reaper-helper-macos-x64
b darwin  arm64 reaper-helper-macos-arm64
ls -la dist
