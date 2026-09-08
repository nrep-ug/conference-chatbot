#!/usr/bin/env bash
set -Eeuo pipefail

deploy() {
APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
APP_NAME="rec-expo-chatbot"
public_url="https://chat.nrep.ug"
evaluation="none"
stage="preflight"
mutating=false
healthy=false

while (($#)); do
  case "$1" in
    --public-url) [[ $# -ge 2 && -n "$2" ]] || { printf '%s\n' 'Missing --public-url value' >&2; exit 1; }; public_url="$2"; shift 2 ;;
    --eval) evaluation="routine"; shift ;;
    --models) evaluation="models"; shift ;;
    --help) printf '%s\n' 'Usage: bash scripts/deploy-vps.sh [--public-url URL] [--eval | --models]' 'Updates an existing main-branch PM2 installation with maintenance downtime.'; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; exit 1 ;;
  esac
done

finish() {
  local status=$?
  if ((status != 0)); then
    printf '\nFailed during %s (exit %s).\n' "$stage" "$status" >&2
    if "$healthy"; then
      printf '%s\n' 'The application passed readiness and remains running; the post-deployment step did not pass.' >&2
    elif "$mutating"; then
      printf '%s\n' 'No rollback or automatic restart was attempted. The app may be stopped or unready.' 'Inspect PM2 and resolve the failure before restarting; installed dependencies/build files may be incomplete.' >&2
    else
      printf '%s\n' 'The running application was not changed.' >&2
    fi
  fi
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cd -- "$APP_DIR"
for command in git npm node pm2 flock; do
  command -v "$command" >/dev/null || { printf 'Required command missing: %s\n' "$command" >&2; exit 1; }
done
[[ -f .env.local && -f package-lock.json && -f pm2/ecosystem.config.js ]] || {
  printf '%s\n' 'Missing .env.local, package-lock.json or PM2 ecosystem file.' >&2; exit 1;
}

# Keep the lock inode; removing it can let concurrent deployments lock different files.
git_dir="$(git rev-parse --git-common-dir)"
exec 9>"$git_dir/conference-chatbot.deploy.lock"
flock -n 9 || { printf '%s\n' 'Another deployment is running.' >&2; exit 1; }
# Do not let a daemon or package child inherit the deployment lock descriptor.
run() { "$@" 9>&-; }
require_clean() {
  local status
  status="$(run git status --porcelain --untracked-files=normal)"
  if [[ -n "$status" ]]; then
    printf '%s\n' "$status" 'Refusing a dirty repository. Review and resolve changes; this script never resets or stashes them.' >&2
    return 1
  fi
}

printf '%s\n' '==> Checking repository and deployment configuration...'
[[ "$(run git branch --show-current)" == "main" ]] || { printf '%s\n' 'Deploy from the main branch only.' >&2; exit 1; }
require_clean
run node --env-file=.env.local scripts/check-chat-api.js --public-url "$public_url" --validate-only
run pm2 describe "$APP_NAME" >/dev/null

stage="fetching the fast-forward update"
printf '%s\n' '==> Fetching latest main (application still running)...'
run git fetch --no-tags origin main
run git merge-base --is-ancestor HEAD FETCH_HEAD || { printf '%s\n' 'main cannot fast-forward to origin/main. Resolve the branch divergence first.' >&2; exit 1; }
require_clean
previous_revision="$(run git rev-parse HEAD)"
printf '==> Previous revision: %s\n' "$previous_revision"

stage="stopping the application for maintenance"
printf '%s\n' '==> Stopping PM2 before changing source, dependencies or .next...'
mutating=true
run pm2 stop "$APP_NAME"
stage="updating source"
run git merge --ff-only FETCH_HEAD
printf '==> Deploying revision: %s\n' "$(run git rev-parse HEAD)"

stage="installing dependencies"
printf '%s\n' '==> Installing locked dependencies...'
run npm ci
require_clean
stage="tests"
printf '%s\n' '==> Running tests and lint...'
run npm test
stage="production build"
printf '%s\n' '==> Building production application...'
run npm run build
stage="PM2 startup"
printf '%s\n' '==> Starting the new build with .env.local...'
run pm2 startOrReload pm2/ecosystem.config.js --update-env

stage="local and public chat API readiness"
printf '%s\n' '==> Checking the chat API locally and through the public proxy...'
run node --env-file=.env.local scripts/check-chat-api.js --public-url "$public_url"
healthy=true
stage="saving PM2 state"
run pm2 save
printf '%s\n' 'Deployment completed; both chat API readiness checks passed.'

if [[ "$evaluation" != "none" ]]; then
  stage="post-deployment chat evaluation"
  printf '%s\n' '==> Running evaluation once, without rebuilding or warming the model first...'
  args=(npm run eval:chat)
  [[ "$evaluation" != "models" ]] || args+=(-- --models)
  if ! run "${args[@]}"; then
    printf '%s\n' 'Review the generated logs/chat-evaluation-*.json report, including latency and actual answers. The deployed app is left running.' >&2
    exit 2
  fi
fi
}

# Parse the full deployment before git can replace this script on disk.
deploy "$@"; exit $?
