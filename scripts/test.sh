#!/bin/sh
# Same as `docker compose run --rm --build tests`, then removes the throwaway *-test containers (compose leaves a run's dependencies up).
# Only those containers are removed by name; the running stack is never stopped (`docker compose down` would stop all of it).
set -u
docker compose run --rm --build tests "$@"
status=$?
docker compose rm -sfv postgres-test s3-test otio-test init-test >/dev/null 2>&1
exit $status
