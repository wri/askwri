#!/usr/bin/env bash
# Bounded, self-explaining replacement for `aws ecs wait services-stable` (#503).
# The waiter fails with an exit code and no attribution: on 2026-11-25 that sent
# someone to `describe-tasks` + CloudWatch by hand to learn "Task failed ELB
# health checks". This polls the same condition against a hard deadline and, when
# it gives up, prints each service's rollout state and every STOPPED task's stop
# reason. Then it asserts the live revisions carry the image tag we just built —
# a green deploy workflow is not proof the deploy succeeded.
set -uo pipefail

CLUSTER=""
SERVICES=""
EXPECTED_TAG=""
TIMEOUT=900
INTERVAL=15

usage() {
  echo "usage: $0 --cluster <name> --services \"<svc> [<svc>...]\" [--expected-image-tag <sha>] [--timeout <sec>] [--interval <sec>]" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  [ $# -ge 2 ] || usage
  case "$1" in
    --cluster) CLUSTER="$2" ;;
    --services) SERVICES="$2" ;;
    --expected-image-tag) EXPECTED_TAG="$2" ;;
    --timeout) TIMEOUT="$2" ;;
    --interval) INTERVAL="$2" ;;
    *) usage ;;
  esac
  shift 2
done
[ -n "$CLUSTER" ] && [ -n "$SERVICES" ] || usage

describe_services() {
  aws ecs describe-services --cluster "$CLUSTER" --services $SERVICES --output json
}

# The waiter's own definition of stable: one deployment per service and the
# running count at the desired count. No missing services.
is_stable() {
  jq -e '(.failures | length) == 0
         and ([.services[] | ((.deployments | length) == 1) and (.runningCount == .desiredCount)] | all)' \
    >/dev/null <<<"$1"
}

report() {
  echo "::error::ECS rollout did not stabilise (bound ${TIMEOUT}s)"
  jq -r '.failures[]? | "MISSING SERVICE \(.arn): \(.reason)"' <<<"$1"
  jq -r '.services[] |
      "SERVICE \(.serviceName): \(.status), running \(.runningCount)/\(.desiredCount)",
      (.deployments[] | "  deployment \(.id)  rev=\(.taskDefinition | split("/") | last)  running=\(.runningCount // "?")/\(.desiredCount // "?") failed=\(.failedTasks // "?") rollout=\(.rolloutState // "?") — \(.rolloutStateReason // "")"),
      "  recent events:",
      (.events[:10][] | "    \(.createdAt) \(.message)")' <<<"$1"

  local svc revs tasks
  for svc in $SERVICES; do
    # The newest deployment is the revision this rollout is trying to land.
    # Picked by createdAt, not by list order, which the API does not promise.
    revs=$(jq -c --arg s "$svc" '[.services[] | select(.serviceName == $s) | .deployments | sort_by(.createdAt) | last | .taskDefinition]' <<<"$1")
    tasks=$(aws ecs list-tasks --cluster "$CLUSTER" --service-name "$svc" \
      --desired-status STOPPED --query 'taskArns[]' --output text 2>/dev/null)
    [ -n "$tasks" ] || continue
    aws ecs describe-tasks --cluster "$CLUSTER" --tasks $tasks --output json \
      | jq -r --argjson revs "$revs" '.tasks[]
          | select(.taskDefinitionArn as $a | $revs | index($a))
          | "STOPPED TASK \(.taskArn | split("/") | last)  \(.stopCode // "?"): \(.stoppedReason // "no reason reported")",
            (.containers[] | select((.exitCode // 0) != 0)
              | "  container \(.name) exit=\(.exitCode) \(.reason // "")")'
  done
}

# Every container in these task definitions is built from var.image_tag, so a
# revision whose image is not tagged with this commit is not this build.
assert_images() {
  [ -n "$EXPECTED_TAG" ] || return 0
  local svc arn img bad=0 images
  for svc in $SERVICES; do
    # An unchecked call here would leave `images` empty, skip the loop below and
    # report success without having checked anything.
    if ! arn=$(aws ecs describe-services --cluster "$CLUSTER" --services "$svc" \
      --query 'services[0].taskDefinition' --output text) || [ -z "$arn" ] || [ "$arn" = "None" ]; then
      echo "::error::$svc: could not read its live task definition"
      bad=1
      continue
    fi
    if ! images=$(aws ecs describe-task-definition --task-definition "$arn" \
      --query 'taskDefinition.containerDefinitions[].image' --output text) || [ -z "$images" ]; then
      echo "::error::$svc: could not read the images of $arn"
      bad=1
      continue
    fi
    for img in $(echo "$images" | tr '\t' '\n' | sort -u); do
      case "$img" in
        *":$EXPECTED_TAG") ;;
        *)
          # One line per service: both containers carry the same image.
          echo "::error::$svc runs $img, not tag $EXPECTED_TAG (task definition $arn)"
          bad=1
          break
          ;;
      esac
    done
  done
  [ "$bad" -eq 0 ] || return 1
  echo "Live revisions all carry image tag $EXPECTED_TAG"
}

start=$SECONDS
while :; do
  json=$(describe_services) || { echo "::error::describe-services failed for $SERVICES"; exit 1; }
  if jq -e '(.failures | length) > 0' >/dev/null <<<"$json"; then
    report "$json" # a name/region typo should not burn the whole timeout
    exit 1
  fi
  if is_stable "$json"; then
    echo "All services stable after $((SECONDS - start))s: $SERVICES"
    break
  fi
  if [ $((SECONDS - start)) -ge "$TIMEOUT" ]; then
    report "$json"
    exit 1
  fi
  sleep "$INTERVAL"
done

assert_images || exit 1
