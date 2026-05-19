#!/bin/sh
# Dispatcher for the thumbsup-fork image. Two real subcommands:
#   build [args...]  - run thumbsup (default)
#   serve [args...]  - run scripts/search_server.py serve
# Plus a `shell` escape hatch for poking around inside the container.
#
# Anything else (including arguments starting with -) is forwarded to
# thumbsup directly, so `docker run thumbsup-fork --input /in --output /out`
# works without typing `build` first.

set -e

case "${1:-}" in
  build)
    shift
    exec node /app/bin/thumbsup.js "$@"
    ;;
  serve)
    shift
    exec /opt/venv/bin/python /app/scripts/search_server.py serve "$@"
    ;;
  shell|bash|sh)
    shift
    # Forward any remaining args, so `... shell -c 'echo hi'` works.
    # With no remaining args, bash drops into an interactive prompt.
    exec /bin/bash "$@"
    ;;
  "")
    exec node /app/bin/thumbsup.js --help
    ;;
  *)
    exec node /app/bin/thumbsup.js "$@"
    ;;
esac
