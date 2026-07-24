#!/bin/bash
set -euo pipefail

# Build and deploy racoder to the local Docker instance using docker-compose.yml
cd "$(dirname "$0")/.."

COMPOSE_FILE="./docker-compose.yml"
SERVICE="racoder"
HEALTHCHECK_RETRIES=10

echo "Building image …"
docker compose -f "$COMPOSE_FILE" build

echo "Deploying …"
docker compose -f "$COMPOSE_FILE" up -d

# Resolve the published host port for the healthcheck
HOST_PORT=$(docker compose -f "$COMPOSE_FILE" port "$SERVICE" 3000 | awk -F: '{print $NF}')

echo "Waiting for healthcheck on port $HOST_PORT …"
for ((i = 1; i <= HEALTHCHECK_RETRIES; i++)); do
  if curl --fail --silent --output /dev/null "http://localhost:$HOST_PORT/healthcheck"; then
    echo "Deployment healthy. Streams:"
    docker compose -f "$COMPOSE_FILE" logs --no-log-prefix "$SERVICE" | grep "available at" | tail -n 5
    exit 0
  fi
  sleep 2
done

echo "Deployment failed healthcheck after $HEALTHCHECK_RETRIES attempts. Recent logs:"
docker compose -f "$COMPOSE_FILE" logs --tail 20 "$SERVICE"
exit 1
