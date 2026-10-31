#!/bin/sh
# Run the built Amaya app headful with THIS checkout's ui/ and a fresh profile.
#
#   ui/tools/dev.sh [extra browser args]     e.g. ui/tools/dev.sh https://example.org
#
# Env: AMAYA_APP     the amaya binary (default: main checkout's dist/stage/amaya/amaya)
#      AMAYA_DARK=1  start with the system theme forced dark
#      KEEP_PROFILE=1 keep the temp profile afterwards
# Chrome console lines (including [amaya-ui:*]) are printed to stdout.
set -eu
TOOLS=$(cd "$(dirname "$0")" && pwd)
UI_DIR=$(dirname "$TOOLS")

APP=$(python3 "$TOOLS/devapp.py" app)
if [ "${AMAYA_DARK:-0}" = 1 ]; then
  PROFILE=$(python3 "$TOOLS/devapp.py" profile --dark)
else
  PROFILE=$(python3 "$TOOLS/devapp.py" profile)
fi
cleanup() {
  if [ "${KEEP_PROFILE:-0}" != 1 ]; then rm -rf "$PROFILE"; else echo "profile kept: $PROFILE"; fi
}
trap cleanup EXIT INT TERM

echo "amaya-ui dev: app=$APP"
echo "amaya-ui dev: AMAYA_UI_DIR=$UI_DIR profile=$PROFILE"
AMAYA_UI_DIR="$UI_DIR" MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1 \
  "$APP/amaya" -no-remote -profile "$PROFILE" "$@"
