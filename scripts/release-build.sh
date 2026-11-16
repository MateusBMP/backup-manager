#!/usr/bin/env bash
# Build the release files from the committed tree, in Docker, with the same
# script as CI's package job (tests/ci/package.sh): each package is built,
# linted, installed, run and removed in its distribution before it is kept.
#
#   scripts/release-build.sh [OUTDIR]          default: release/<version>
#   DISTROS="debian12 arch" scripts/release-build.sh   a subset
#
# Output in OUTDIR:
#   backup-manager-<version>.tar.gz                    sources and the built bundle (make dist)
#   backup-manager_<version>_<distro>_all.deb          one per Debian/Ubuntu release
#   backup-manager-<version>-1-any.pkg.tar.zst         Arch
#   SHA256SUMS
#   logs/<distro>/                                     package.log, build and lint logs
# fedora44 produces no file: it checks `make install` from the tarball.
# The npm tarball is not built here: CI stages the one it tested (the `stage` job).
# Exit status: the number of distributions that failed.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
NAME=backup-manager
VERSION=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' package.json | head -n 1)
OUT=${1:-release/$VERSION}
declare -A IMAGES=([debian12]=debian:12 [debian13]=debian:13 [ubuntu2404]=ubuntu:24.04
                   [ubuntu2604]=ubuntu:26.04 [fedora44]=fedora:44 [arch]=archlinux:latest)
read -ra distros <<<"${DISTROS:-debian12 debian13 ubuntu2404 ubuntu2604 fedora44 arch}"

if [[ -n $(git status --porcelain --untracked-files=no) && -z ${ALLOW_DIRTY:-} ]]; then
    echo "release-build.sh: the tree has uncommitted changes; commit them first (or ALLOW_DIRTY=1)" >&2; exit 2
fi
for d in "${distros[@]}"; do
    [[ -n ${IMAGES[$d]:-} ]] || { echo "release-build.sh: unknown distro $d" >&2; exit 2; }
done
rm -rf "$OUT"; mkdir -p "$OUT/logs"
OUT=$(cd "$OUT" && pwd)

# A clean export of HEAD: the packages must hold what the tag will hold, built
# from package-lock.json, not from this checkout's node_modules or dist/.
SRC=$(mktemp -d "${TMPDIR:-/tmp}/$NAME-release.XXXXXX")
trap 'rm -rf "$SRC"' EXIT
git archive HEAD | tar -C "$SRC" -xf -

if ! (cd "$SRC" && make -s dist >"$OUT/logs/dist.log" 2>&1); then
    echo "release-build.sh: make dist failed (see $OUT/logs/dist.log)" >&2; tail -5 "$OUT/logs/dist.log" >&2; exit 1
fi
cp "$SRC/$NAME-$VERSION.tar.gz" "$OUT/"
echo "source  $NAME-$VERSION.tar.gz"

build_one() {
    local d=$1 res=$OUT/logs/$1
    mkdir -p "$res"
    docker run --rm -v "$SRC:/src:ro" -v "$res:/results" "${IMAGES[$d]}" bash /src/tests/ci/package.sh \
        >"$res/docker.log" 2>&1
}
for d in "${distros[@]}"; do build_one "$d" & done
wait

failed=0
for d in "${distros[@]}"; do
    res=$OUT/logs/$d
    if [[ ! -s $res/package.log ]] || grep -q '^FAIL' "$res/package.log"; then
        echo "FAIL    $d (see $res/package.log, $res/docker.log)"; grep '^FAIL' "$res/package.log" 2>/dev/null | sed 's/^/        /'
        failed=$((failed + 1)); continue
    fi
    checks=$(grep -c '^PASS' "$res/package.log")
    case $d in
    fedora*) echo "ok      $d  make install from the tarball  ($checks checks)"; continue ;;
    arch) f=$(ls "$res"/$NAME-*.pkg.tar.* 2>/dev/null | head -1); [[ -n $f ]] && mv "$f" "$OUT/" ;;
    *)  f=$(ls "$res"/${NAME}_*_all.deb 2>/dev/null | head -1)
        # The plain version in the name: GitHub rewrites a Debian "~" in asset names.
        [[ -n $f ]] && { name=${NAME}_${VERSION}_${d}_all.deb; mv "$f" "$OUT/$name"; f=$name; } ;;
    esac
    if [[ -z $f ]]; then echo "FAIL    $d (no package in $res)"; failed=$((failed + 1)); continue; fi
    echo "ok      $d  $(basename "$f")  ($checks checks)"
done

(cd "$OUT" && sha256sum -- *.tar.gz *.deb *.pkg.tar.* 2>/dev/null >SHA256SUMS)
echo "out     $OUT"
exit $failed
