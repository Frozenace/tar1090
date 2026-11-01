#!/bin/bash
set -e

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
IPATH="/usr/local/share/tar1090"
HTML_PATH="$IPATH/html"
TMP="$IPATH/.instance_tmp"

TAR_VERSION="$(git -C "$PROJECT_DIR" rev-parse --short HEAD 2>/dev/null || echo "custom")-$(date +%s)"
DB_VERSION="$(cat "$IPATH/git-db/version" 2>/dev/null || ls "$HTML_PATH" | grep '^db-' | sed 's/^db-//' | head -n1)"

sudo rm -rf "$TMP"
sudo mkdir -p "$TMP"
sudo chmod 755 "$TMP"

sudo cp -r -T "$PROJECT_DIR/html" "$TMP"
if [[ -d "$IPATH/git-db/db" ]]; then
    sudo cp -r -T "$IPATH/git-db/db" "$TMP/db-$DB_VERSION"
elif [[ -d "$HTML_PATH/db-$DB_VERSION" ]]; then
    sudo cp -r -T "$HTML_PATH/db-$DB_VERSION" "$TMP/db-$DB_VERSION"
fi

# Carto basemap key lives outside the repo (never committed): /etc/tar1090-carto.key
if sudo test -r /etc/tar1090-carto.key; then
    printf '\ncarto_api_key = "%s";\n' "$(sudo cat /etc/tar1090-carto.key)" | sudo tee -a "$TMP/config.js" >/dev/null
fi

sudo sed -i -e "s/let databaseFolder = .*;/let databaseFolder = \"db-$DB_VERSION\";/" "$TMP/index.html"
echo "{ \"tar1090Version\": \"$TAR_VERSION\", \"databaseVersion\": \"$DB_VERSION\" }" | sudo tee "$TMP/version.json" >/dev/null

if [[ -f "$HTML_PATH/upintheair.json" ]]; then
    sudo cp "$HTML_PATH/upintheair.json" "$TMP/upintheair.json"
fi

sudo sed -i -e 's/id="webinterface_version">/\0'"(${TAR_VERSION})/" "$TMP/index.html"

cd "$TMP"
sudo "$PROJECT_DIR/cachebust.sh" "$PROJECT_DIR/cachebust.list" "$TMP"

sudo rm -rf "$HTML_PATH"
sudo mv "$TMP" "$HTML_PATH"

echo "Successfully deployed tar1090-project to $HTML_PATH"
