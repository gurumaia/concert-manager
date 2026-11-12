#!/usr/bin/env bash
# Deploy the backend stack, then publish the web app.
#   ./deploy.sh -e dev|prd [-p aws-profile]
# Per-environment values (stack suffix, domain) live in env/<env>.params. -e is required: there is no default environment.
# Google values come from the environment (never committed). One client serves both Sign in with Google and Calendar:
#   export GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=...
# Use SIGNIN_GOOGLE_CLIENT_ID/SECRET or CALENDAR_GOOGLE_CLIENT_ID/SECRET only to give one of them a different client.
# Optional: export SETLISTFM_API_KEY=... (free key from https://www.setlist.fm/settings/api) to enable setlist lookups.
# Parameters you don't pass keep their current value on an existing stack (sam deploy sends UsePreviousValue),
# so the Google values only need exporting the first time or when they change.
set -euo pipefail
SIGNIN_GOOGLE_CLIENT_ID="${SIGNIN_GOOGLE_CLIENT_ID:-${GOOGLE_CLIENT_ID:-}}"
SIGNIN_GOOGLE_CLIENT_SECRET="${SIGNIN_GOOGLE_CLIENT_SECRET:-${GOOGLE_CLIENT_SECRET:-}}"
CALENDAR_GOOGLE_CLIENT_ID="${CALENDAR_GOOGLE_CLIENT_ID:-${GOOGLE_CLIENT_ID:-}}"
CALENDAR_GOOGLE_CLIENT_SECRET="${CALENDAR_GOOGLE_CLIENT_SECRET:-${GOOGLE_CLIENT_SECRET:-}}"
for v in SIGNIN CALENDAR; do
  id="${v}_GOOGLE_CLIENT_ID"; sec="${v}_GOOGLE_CLIENT_SECRET"
  if [ -n "${!id}" ] && [ -z "${!sec}" ]; then echo "$id is set but $sec is empty." >&2; exit 1; fi
done
ENV=""; PROFILE_ARGS=()
while getopts "e:p:" o; do case $o in e) ENV=$OPTARG;; p) PROFILE_ARGS=(--profile "$OPTARG");; *) exit 1;; esac; done
case "$ENV" in dev | prd) : ;; *) echo "usage: $0 -e dev|prd [-p aws-profile]" >&2; exit 1 ;; esac
cd "$(dirname "$0")"
STACK="show-manager-$ENV"; REGION="${AWS_REGION:-us-east-1}"

# the Lambda bundle inlines the MCP App page, so the frontend app bundle is built first
(cd backend && npm ci)
(cd frontend && npm ci && npm test && npm run build)
(cd backend && npm test && npm run build)
sam build --no-cached
PARAMS=(); while IFS= read -r line; do [ -n "$line" ] && PARAMS+=("$line"); done < "env/$ENV.params"
[ -n "${SIGNIN_GOOGLE_CLIENT_ID:-}" ] && PARAMS+=("SignInGoogleClientId=$SIGNIN_GOOGLE_CLIENT_ID" "SignInGoogleClientSecret=$SIGNIN_GOOGLE_CLIENT_SECRET")
[ -n "${CALENDAR_GOOGLE_CLIENT_ID:-}" ] && PARAMS+=("CalendarGoogleClientId=$CALENDAR_GOOGLE_CLIENT_ID" "CalendarGoogleClientSecret=$CALENDAR_GOOGLE_CLIENT_SECRET")
[ -n "${SETLISTFM_API_KEY:-}" ] && PARAMS+=("SetlistFmApiKey=$SETLISTFM_API_KEY")
sam deploy --stack-name "$STACK" --region "$REGION" "${PROFILE_ARGS[@]}" --resolve-s3 \
  --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset --parameter-overrides "${PARAMS[@]}"

out() { aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" "${PROFILE_ARGS[@]}" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
BUCKET=$(out SiteBucketName); DIST=$(out DistributionId)
aws s3 sync frontend/dist "s3://$BUCKET" --delete "${PROFILE_ARGS[@]}"
aws cloudfront create-invalidation --distribution-id "$DIST" --paths '/*' "${PROFILE_ARGS[@]}" >/dev/null
echo "Site:  $(out SiteUrl)"; echo "MCP:   $(out McpUrl)"
echo "Google Calendar redirect URI: $(out GoogleCalendarRedirectUri)"
echo "Google sign-in redirect URI:  $(out GoogleSignInRedirectUri)"
