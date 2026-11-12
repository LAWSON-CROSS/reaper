#!/bin/sh
# Reaper helper installer for macOS and Linux.
#   curl -fsSL https://raw.githubusercontent.com/LAWSON-CROSS/reaper/main/install.sh | sh
set -e
REPO="LAWSON-CROSS/reaper"
case "$(uname -s)" in
  Darwin) os=macos ;;
  Linux)  os=linux ;;
  *) echo "Unsupported system. On Windows, download 'Reaper Setup.exe' instead."; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64)  arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) echo "Unsupported processor: $(uname -m)"; exit 1 ;;
esac
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "Downloading the Reaper helper ($os $arch)..."
curl -fL --progress-bar -o "$tmp/reaper-setup" "https://github.com/$REPO/releases/latest/download/reaper-helper-$os-$arch"
chmod +x "$tmp/reaper-setup"
"$tmp/reaper-setup" "$@"
