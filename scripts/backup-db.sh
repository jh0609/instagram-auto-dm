#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_DB_PATH="$ROOT_DIR/data/instagram_auto_dm.sqlite"
DB_PATH="${SQLITE_PATH:-$DEFAULT_DB_PATH}"

if [[ "$DB_PATH" != /* ]]; then
  DB_PATH="$ROOT_DIR/$DB_PATH"
fi

BACKUP_DIR="$ROOT_DIR/backups"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_PATH="$BACKUP_DIR/instagram_auto_dm.$TIMESTAMP.sqlite"

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 command is required" >&2
  exit 1
fi

if [[ ! -f "$DB_PATH" ]]; then
  echo "SQLite DB not found: $DB_PATH" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

sqlite3 "$DB_PATH" ".backup '$BACKUP_PATH'"

mapfile -t BACKUPS < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'instagram_auto_dm.*.sqlite' -printf '%T@ %p\n' | sort -rn | sed -n '15,$s/^[^ ]* //p')

for old_backup in "${BACKUPS[@]}"; do
  rm -f -- "$old_backup"
done

echo "Backup created: $BACKUP_PATH"
