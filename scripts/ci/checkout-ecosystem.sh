#!/usr/bin/env bash
# Check out the sibling repositories this workspace resolves through Composer path repositories and npm `file:`
# dependencies (../vaulter, ../packman), next to the repository root, as a local checkout has them.
#
#   VAULTER_READ_TOKEN        token that can read the private siblings (CI secret); anonymous when empty
#   VAULTER_ECOSYSTEM_OWNER   GitHub owner of the siblings (default axiomasoft; a mirror may point elsewhere)
#   VAULTER_REF               ref of the base repository (default refs/heads/main)
#
# packman is fetched at the tag the root composer.json pins, so CI installs exactly the tree a release resolves.
set -euo pipefail

root=$(git rev-parse --show-toplevel)
workspace=$(dirname "$root")
owner=${VAULTER_ECOSYSTEM_OWNER:-axiomasoft}
packman_version=$(jq -er '.repositories[] | select(.url == "../packman/packages/*") | .options.versions["axiomasoft/packman"]' "$root/composer.json")

auth=()
if [[ -n "${VAULTER_READ_TOKEN:-}" ]]; then
    # A header, not a token in the URL: it never lands in .git/config or in a log line.
    auth=(-c "http.extraHeader=Authorization: Basic $(printf 'x-access-token:%s' "$VAULTER_READ_TOKEN" | base64 -w0)")
fi

fetch_dependency() {
    local directory=$1 repository=$2 ref=$3
    local destination="$workspace/$directory"
    if [[ -e "$destination" ]]; then
        echo "checkout-ecosystem: $directory already present, kept"
        return 0
    fi
    mkdir -p "$destination"
    git -C "$destination" init -q
    GIT_TERMINAL_PROMPT=0 git "${auth[@]}" -C "$destination" fetch --quiet --depth=1 "https://github.com/$owner/$repository.git" "$ref"
    git -C "$destination" checkout -q -b main FETCH_HEAD
    echo "checkout-ecosystem: $directory at $ref ($(git -C "$destination" rev-parse --short HEAD))"
}

fetch_dependency packman packman "refs/tags/v$packman_version"
fetch_dependency vaulter vaulter "${VAULTER_REF:-refs/heads/main}"
