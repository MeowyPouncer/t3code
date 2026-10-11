#!/bin/bash
# Fork-local (mp): builds a slim local release of a fork commit into $T3_RELEASES/v<version>-mp-<tree>/.
# The release is electron-builder's linux-unpacked app (`build-desktop-artifact.ts --target dir`): Electron, the
# app.asar with the desktop, server and web bundles, and only the production dependencies those bundles leave
# external. It replaces the rsync copy of the whole workspace (~5 GB). The launcher runs `<release>/t3code`.
# Auto-update stays off three ways: no publish config (no resources/app-update.yml), electron-updater refuses
# Linux installs that are neither AppImage nor .deb, and the launcher sets T3CODE_DISABLE_AUTO_UPDATE=1.
#
# Usage: scripts/build-local-release.sh [<ref>]   (default mp/main; run it from any checkout of the fork)
#   T3_FORK         fork checkout whose refs are built            (/home/mp/Projects/SideProjects/t3code)
#   T3_RELEASES     releases directory                             (/home/mp/Projects/SideProjects/t3code-local-releases)
#   T3_RELEASE_BUILD  detached build worktree, kept for its node_modules  (~/.cache/t3code-release-build)
#   T3_RELEASE_CHECKS  text for the manifest's "checks" field      (checks are not run here)
#   T3_HEAVY_MEM    memory cap for heavy.sh                        (12G)
# Activation is separate: release/switch-on-quit.sh <old-release> <new-release> --launcher <launcher template>.
set -euo pipefail

FORK=${T3_FORK:-/home/mp/Projects/SideProjects/t3code}
REL=${T3_RELEASES:-/home/mp/Projects/SideProjects/t3code-local-releases}
BUILD=${T3_RELEASE_BUILD:-$HOME/.cache/t3code-release-build}
HARNESS=/home/mp/.local/share/aihub-t3-harness
HEAVY=$HARNESS/fork/heavy.sh
export T3_HEAVY_MEM=${T3_HEAVY_MEM:-12G}
ref=${1:-mp/main}
fail() { echo "build-local-release: $1" >&2; exit 1; }
log() { echo "build-local-release: $*"; }

commit=$(git -C "$FORK" rev-parse --verify "$ref^{commit}") || fail "unknown ref $ref"
tree=$(git -C "$FORK" rev-parse --short=7 "$commit^{tree}")
version=$(git -C "$FORK" show "$commit:apps/desktop/package.json" | jq -r .version)
name="v$version-mp-$tree"
dest="$REL/$name"
[ -e "$dest" ] && fail "$dest already exists"
. "$FORK/.t3-env.sh" || fail "toolchain env missing ($FORK/.t3-env.sh)"

if [ -d "$BUILD/.git" ] || [ -f "$BUILD/.git" ]; then
  git -C "$BUILD" checkout -q --detach --force "$commit"
  # Keep node_modules (the install is the slow part); drop every other untracked or ignored file, dist included.
  git -C "$BUILD" clean -q -ffdx -e node_modules
else
  git -C "$FORK" worktree add -q --detach "$BUILD" "$commit"
fi
log "building $name from ${commit:0:10} in $BUILD"

stage="$REL/.stage-$tree"
rm -rf "$stage" && mkdir -p "$stage"
trap 'rm -rf "$stage"' EXIT
start=$(date +%s)
cd "$BUILD"
"$HEAVY" vp i --frozen-lockfile >"$stage/install.log" 2>&1 || { cat "$stage/install.log" >&2; fail "install failed"; }
# The stage dir is a temp dir; TMPDIR keeps it (and its prod install) on this disk, out of tmpfs and next to $dest.
"$HEAVY" env -u GITHUB_REPOSITORY -u T3CODE_DESKTOP_UPDATE_REPOSITORY -u T3CODE_DESKTOP_MOCK_UPDATES TMPDIR="$stage" \
  node scripts/build-desktop-artifact.ts --platform linux --target dir --arch x64 --keep-stage \
  --output-dir "$stage/out" >"$stage/build.log" 2>&1 || { tail -60 "$stage/build.log" >&2; fail "build failed"; }
seconds=$(( $(date +%s) - start ))

# --target dir leaves the unpacked app in the stage; the artifact step copies files only.
shopt -s nullglob
unpacked=("$stage"/t3code-desktop-linux-stage-*/app/dist/linux-unpacked)
[ ${#unpacked[@]} -eq 1 ] || fail "expected one linux-unpacked dir in $stage, found ${#unpacked[@]}"
app=${unpacked[0]}
[ -x "$app/t3code" ] && [ -f "$app/resources/app.asar" ] || fail "linux-unpacked has no t3code or app.asar"
[ -e "$app/resources/app-update.yml" ] && fail "the build carries an update feed (resources/app-update.yml)"
mv "$app" "$dest"

files=$(find "$dest" -type f | wc -l)
size=$(du -sh "$dest" | cut -f1)
active="$REL/active-release.json"
base=$(jq -r '.releaseDirectory // empty' "$active" 2>/dev/null || true)
baseCommit=$(jq -r '.sourceCommit // empty' "$active" 2>/dev/null | cut -d' ' -f1)
upstream=$(sed -n 's/^upstream=//p' "$HARNESS/fork-pin" 2>/dev/null || true)
# Cards since the active release: the card IDs in the first-parent merge subjects.
cards='{}'
if [ -n "$baseCommit" ] && git -C "$FORK" rev-parse -q --verify "$baseCommit^{commit}" >/dev/null; then
  cards=$(git -C "$FORK" log --first-parent --format=%s "$baseCommit..$commit" \
    | sed -n 's/^merge: \(T3MIG-\)\{0,1\}\(FORK-[0-9]*\) — \(.*\)$/\2\t\3/p' \
    | jq -R -s 'split("\n") | map(select(length > 0) | split("\t") | {(.[0]): .[1]}) | add // {}')
fi
jq -n --arg version "$version" --arg upstream "$upstream" \
  --arg source "${commit:0:10} ($ref): $(git -C "$FORK" log -1 --format=%s "$commit")" \
  --arg tree "$tree" --arg dir "$dest" --arg base "$base" --argjson cards "$cards" \
  --arg checks "${T3_RELEASE_CHECKS:-not run by build-local-release.sh}" \
  --arg build "scripts/build-local-release.sh: electron-builder linux-unpacked (--target dir) in $BUILD (heavy.sh, $T3_HEAVY_MEM cap), $seconds s; $files files, $size" \
  --arg launcher "$FORK/.t3-desktop.sh" \
  --arg rollback "/home/mp/Projects/SideProjects/.t3-activation-$name/rollback" \
  '{version: $version, upstreamCommit: $upstream, sourceCommit: $source, tree: $tree, format: "linux-unpacked",
    releaseDirectory: $dir, baseRelease: $base, cards: $cards, checks: $checks, build: $build,
    launcher: $launcher, rollbackDirectory: $rollback,
    activation: "switch-on-quit.sh flips the launcher once T3 has fully quit; reopen «T3 Code (fork)»"}' \
  >"$dest/local-release-manifest.json"
log "done: $dest ($size, $files files, $seconds s)"
