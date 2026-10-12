#!/bin/bash
# 打包扩展为 zip（Chrome 应用商店 / 手动分发用）
set -e
cd "$(dirname "$0")/.."
NAME="deepseek-sidebar-agent-$(date +%Y%m%d).zip"
rm -f "$NAME"
zip -qr "$NAME" manifest.json src icons docs README.md LICENSE .gitignore -x '*/.*'
echo "packed: $NAME"
