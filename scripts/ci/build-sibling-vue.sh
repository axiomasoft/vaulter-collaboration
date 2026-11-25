#!/usr/bin/env bash
# Install and build sibling @vaulter/vue (../vaulter) so this repository's Vue adapter
# type-checks and the e2e playground can resolve TipTap types from that package.
# checkout-ecosystem.sh must have fetched the sibling first.
set -euo pipefail

root=$(git rev-parse --show-toplevel)
vue_root="$(dirname "$root")/vaulter"
if [[ ! -f "$vue_root/package.json" ]]; then
    echo "build-sibling-vue: $vue_root is missing; run scripts/ci/checkout-ecosystem.sh first" >&2
    exit 1
fi
npm --prefix "$vue_root" ci
npm --prefix "$vue_root" run build --workspace=@vaulter/vue
test -f "$vue_root/packages/vue/dist/index.d.ts"
