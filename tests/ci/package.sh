#!/bin/bash
# Build, lint, install, run and remove the distribution package inside a distro
# container (no systemd running there: only the program itself is exercised).
#
#   make dist      # backup-manager-VERSION.tar.gz at the top of the tree
#   docker run --rm -v "$PWD:/src:ro" -v "$PWD/results:/results" debian:12 bash /src/tests/ci/package.sh
#
# The package is built from the release tarball in /src, which carries the
# JavaScript already built, so nothing here needs npm.
#
# Debian/Ubuntu: dpkg-buildpackage, lintian, apt install, purge.
# Arch: makepkg as an unprivileged user, namcap, pacman -U, pacman -Rns.
# Fedora (no package): make install, make install again (upgrade), make uninstall.
#
# Node.js 22 or later comes from the distribution where it has one (Ubuntu 26.04,
# Fedora, Arch) and from NodeSource elsewhere (Debian 12/13, Ubuntu 24.04), which
# is what the Installation page tells users to do.
#
# Output: /results/package.log with PASS/FAIL/INFO lines, the built package in
# /results/. The exit status is 0 even when checks fail: read the log.
set -uo pipefail
RESULTS=${RESULTS:-/results}
mkdir -p "$RESULTS"; chmod 0777 "$RESULTS"
trap 'chmod -R a+rX "$RESULTS"' EXIT
LOG=$RESULTS/package.log
. /etc/os-release
D="[$ID${VERSION_ID:+$VERSION_ID}]"; [[ $ID == arch ]] && D="[arch]"  # VERSION_ID there is a build date
report() { printf '%-5s %-62s %s\n' "$1" "$D $2" "${3:-}" | tee -a "$LOG"; }
ok() { local name=$1 detail=$2; shift 2; if "$@"; then report PASS "$name" "$detail"; else report FAIL "$name" "$detail"; fi; }
: >"$LOG"

NAME=backup-manager
LIB=/usr/lib/$NAME
tarball=$(ls /src/$NAME-*.tar.gz 2>/dev/null | head -1)
[[ -n $tarball ]] || { report FAIL "release tarball" "no /src/$NAME-*.tar.gz: run make dist first"; exit 0; }
VERSION=$(basename "$tarball" .tar.gz); VERSION=${VERSION#"$NAME"-}
report INFO "tarball" "$(basename "$tarball") ($(du -h "$tarball" | cut -f1))"

# Work on a copy: the source mount stays read-only and clean.
mkdir -p /build
tar -C /build -xzf "$tarball"
WORK=/build/$NAME-$VERSION
[[ -f $WORK/bundle/dist/cli.js ]] || { report FAIL "tarball carries the built bundle" "no bundle/dist/cli.js"; exit 0; }

# The distribution's nodejs when it is new enough, NodeSource's otherwise.
nodesource() {
    apt-get install -y -qq --no-install-recommends ca-certificates curl gnupg >/dev/null
    mkdir -p /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
        >/etc/apt/sources.list.d/nodesource.list
    apt-get update -qq
}

installed_files() {  # the package's own files and links (not directories)
    case $ID in
    arch) pacman -Qlq $NAME | grep -v '/$' ;;
    fedora) grep -v '/$' /var/lib/$NAME-install.manifest ;;
    # Not directories, nor links to them (dpkg lists /lib, a link to usr/lib on merged-/usr).
    *) dpkg -L $NAME | while read -r f; do [[ ( -f $f || -L $f ) && ! -d $f ]] && echo "$f"; done ;;
    esac
}

# A scheduled run through the real daemon: a project is archived every two seconds.
daemon_backup() {
    local t; t=$(mktemp -d)
    mkdir -p "$t/app/storage/app/public" "$t/app/storage/logs"
    echo hello >"$t/app/storage/app/public/hello.txt"
    echo noise >"$t/app/storage/logs/laravel.log"
    : >"$t/app/artisan"
    cat >"$t/config.json" <<EOF
{ "settings": { "backupDir": "$t/backups", "stateDir": "$t/state" },
  "api": { "port": 18080 },
  "environments": [ { "name": "ci", "schedule": "*/2 * * * * *",
    "projects": [ { "name": "app", "path": "$t/app", "include": ["storage"] } ] } ] }
EOF
    out=$(bkm -c "$t/config.json" doctor --no-db 2>&1); rc=$?
    echo "$out" >"$RESULTS/doctor.log"
    ok "bkm doctor --no-db: the config is valid" "exit $rc" grep -q "is valid" "$RESULTS/doctor.log"

    bkm -c "$t/config.json" daemon >"$RESULTS/daemon.log" 2>&1 &
    local pid=$! archive="" health="" i
    for i in $(seq 1 40); do
        archive=$(ls "$t"/backups/ci/2*/projects/app.tar.gz 2>/dev/null | head -1)
        [[ -n $archive && -f $(dirname "$(dirname "$archive")")/manifest.json ]] && break
        sleep 0.5
    done
    health=$(node -e 'fetch("http://127.0.0.1:18080/health").then(r=>r.json()).then(j=>console.log(j.status,j.version)).catch(e=>console.log("error",e.message))')
    kill -TERM $pid 2>/dev/null; wait $pid; rc=$?
    ok "daemon: a scheduled backup completed" "${archive:-no archive after 20s}" test -n "$archive"
    local dir; dir=$(dirname "$(dirname "${archive:-/nonexistent/x/y}")")
    ok "daemon: manifest.json says complete" "" grep -q '"status": *"complete"' "$dir/manifest.json"
    ok "daemon: the archive holds the file, not the excluded log" "" \
        bash -c "tar -tzf '$archive' | grep -q 'storage/app/public/hello.txt' && ! tar -tzf '$archive' | grep -q 'laravel.log'"
    ok "daemon: API /health" "$health" test "$health" = "ok $VERSION"
    ok "daemon: stops cleanly on SIGTERM" "exit $rc" bash -c "[ $rc -eq 0 ] && grep -q '^stopped' '$RESULTS/daemon.log'"
    rm -rf "$t"
}

after_install_checks() {
    report INFO "node" "$(command -v node) $(node --version 2>&1)"
    ok "bkm --version" "$(bkm --version 2>&1 | head -1)" \
        bash -c "bkm --version | head -1 | grep -qx 'bkm (backup-manager) $VERSION' && bkm --version | grep -q 'Copyright (C) 2026 MateusBMP'"
    ok "bkm --help names the licence" "" bash -c 'bkm --help | grep -q "GNU GPL version 3 only" && bkm --help | grep -q "NO WARRANTY"'
    ok "/usr/bin/bkm links into $LIB" "$(readlink /usr/bin/bkm 2>&1)" test "$(readlink -f /usr/bin/bkm)" = "$LIB/dist/cli.js"
    ok "files are root-owned and not writable by others" "" \
        bash -c "[ -z \"\$(find $LIB \( ! -user root -o -perm /022 \) ! -type l | head -1)\" ]"
    ok "dependencies keep their licence files" "$(find $LIB/node_modules -maxdepth 3 -iname 'licen[cs]e*' | wc -l) files" \
        bash -c "ls $LIB/node_modules/ink/license $LIB/node_modules/tar/LICENSE.md >/dev/null"
    local lic=/usr/share/licenses/$NAME/LICENSE
    [[ $ID == debian || $ID == ubuntu ]] && lic=/usr/share/doc/$NAME/copyright
    ok "licence installed" "$lic" grep -q "GPL-3.0-only\|GNU GENERAL PUBLIC LICENSE" "$lic"
    # Debian compresses large documents (dh_compress): zcat -f reads both forms.
    local third; third=$(ls "$(dirname "$lic")"/THIRD-PARTY-LICENSES.txt* 2>/dev/null | head -1)
    ok "third-party licences installed" "${third:-missing}: $(zcat -f "${third:-/dev/null}" | grep -c '^License: ') libraries" \
        bash -c "zcat -f '${third:-/dev/null}' | grep -q '^License: BlueOak-1.0.0'"
    bkm -c /nonexistent/config.json doctor >/dev/null 2>&1; rc=$?
    ok "bkm doctor without a config exits 2" "exit $rc" test $rc -eq 2
    daemon_backup
}

case $ID in
debian|ubuntu)
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends build-essential debhelper lintian >/dev/null
    candidate=$(apt-cache policy nodejs | sed -n 's/^ *Candidate: *\([0-9]*\).*/\1/p')
    if [[ ${candidate:-0} -lt 22 ]]; then
        nodesource
        report INFO "nodejs" "the distribution has ${candidate:-none}; using NodeSource 22"
    else
        report INFO "nodejs" "from the distribution ($candidate)"
    fi
    cp -a "$WORK/packaging/debian" "$WORK/debian"
    out=$(cd "$WORK" && dpkg-buildpackage -us -uc -b 2>&1); rc=$?
    echo "$out" >"$RESULTS/build.log"
    ok "dpkg-buildpackage (no npm, no network)" "$(tail -1 <<<"$out")" test $rc -eq 0
    deb=$(ls /build/${NAME}_*_all.deb 2>/dev/null | head -1)
    [[ -n $deb ]] || { report FAIL "package built" "see build.log"; exit 0; }
    cp "$deb" "$RESULTS/"
    info=$(dpkg-deb -I "$deb" | grep -E '^ (Version|Depends|Installed-Size):' | tr -s ' ' | tr '\n' ';')
    report INFO "package" "$(basename "$deb") ($(du -h "$deb" | cut -f1)); $info"
    lint=$(lintian --tag-display-limit 0 "$deb" 2>&1); echo "$lint" >"$RESULTS/lintian.log"
    ok "lintian: no errors" "$(grep -c '^E:' <<<"$lint") E, $(grep -c '^W:' <<<"$lint") W" bash -c "! grep -q '^E:' '$RESULTS/lintian.log'"
    grep -E '^(E|W):' <<<"$lint" | sed 's/ \[.*//' | sort | uniq -c | sort -rn | head -15 | while IFS= read -r l; do report INFO "lintian" "$l"; done
    out=$(apt-get install -y -qq --no-install-recommends "$deb" 2>&1); rc=$?
    ok "apt install" "$(tail -1 <<<"$out")" test $rc -eq 0
    files=$(installed_files)
    after_install_checks
    out=$(apt-get purge -y -qq $NAME 2>&1); rc=$?
    ok "apt purge" "$(tail -1 <<<"$out")" test $rc -eq 0
    ;;
arch)
    pacman -Syu --noconfirm --needed --noprogressbar base-devel namcap nodejs >/dev/null 2>&1
    id builder >/dev/null 2>&1 || useradd -m builder
    cp "$tarball" "$WORK/packaging/arch/"
    chown -R builder: /build
    out=$(cd "$WORK/packaging/arch" && su builder -c 'makepkg -f --noconfirm --nodeps' 2>&1); rc=$?
    echo "$out" >"$RESULTS/build.log"
    ok "makepkg (no npm, no network)" "$(tail -1 <<<"$out")" test $rc -eq 0
    pkg=$(ls "$WORK"/packaging/arch/$NAME-*.pkg.tar.* 2>/dev/null | head -1)
    [[ -n $pkg ]] || { report FAIL "package built" "see build.log"; exit 0; }
    cp "$pkg" "$RESULTS/"
    report INFO "package" "$(basename "$pkg") ($(du -h "$pkg" | cut -f1))"
    lint=$(namcap "$WORK/packaging/arch/PKGBUILD" "$pkg" 2>&1); echo "$lint" >"$RESULTS/namcap.log"
    ok "namcap: no errors" "$(grep -c ' E: ' <<<"$lint") E, $(grep -c ' W: ' <<<"$lint") W" bash -c "! grep -q ' E: ' '$RESULTS/namcap.log'"
    grep -E ' (E|W): ' <<<"$lint" | head -15 | while IFS= read -r l; do report INFO "namcap" "$l"; done
    out=$(pacman -U --noconfirm --noprogressbar "$pkg" 2>&1); rc=$?
    ok "pacman -U" "$(tail -1 <<<"$out")" test $rc -eq 0
    files=$(installed_files)
    after_install_checks
    out=$(pacman -Rns --noconfirm $NAME 2>&1); rc=$?
    ok "pacman -Rns" "$(tail -1 <<<"$out")" test $rc -eq 0
    ;;
fedora)
    dnf install -y -q make nodejs tar gzip findutils >/dev/null 2>&1
    out=$(cd "$WORK" && make install 2>&1); rc=$?
    echo "$out" >"$RESULTS/build.log"
    ok "make install (no npm, no network)" "$(tail -1 <<<"$out")" test $rc -eq 0
    [[ -f /var/lib/$NAME-install.manifest ]] || { report FAIL "install manifest" "see build.log"; exit 0; }
    report INFO "install" "$(grep -vc '/$' /var/lib/$NAME-install.manifest) files, $(du -sh $LIB | cut -f1)"
    files=$(installed_files)
    after_install_checks
    out=$(cd "$WORK" && make install 2>&1); rc=$?
    ok "make install again (upgrade in place)" "$(tail -1 <<<"$out")" bash -c "[ $rc -eq 0 ] && bkm --version >/dev/null"
    echo "not ours" >/usr/bin/bkm.conflict-test
    out=$(cd "$WORK" && make uninstall 2>&1); rc=$?
    ok "make uninstall" "$(tail -1 <<<"$out")" test $rc -eq 0
    ok "make uninstall keeps files it did not install" "" test -f /usr/bin/bkm.conflict-test
    # A path owned by someone else: the install must refuse and change nothing.
    mkdir -p /usr/bin && echo "not ours" >/usr/bin/bkm
    out=$(cd "$WORK" && make install 2>&1); rc=$?
    ok "make install refuses a foreign /usr/bin/bkm" "$(tail -1 <<<"$out")" \
        bash -c "[ $rc -ne 0 ] && [ ! -e $LIB ] && grep -qx 'not ours' /usr/bin/bkm"
    rm -f /usr/bin/bkm /usr/bin/bkm.conflict-test
    ;;
*)
    report SKIP "package" "no package for $ID"; exit 0 ;;
esac

left=$(while IFS= read -r f; do [[ -n $f && ( -e $f || -L $f ) ]] && echo "$f"; done <<<"$files")
ok "removal leaves none of the package's files" "${left:-none}" test -z "$left"
ok "removal leaves no $LIB" "" test ! -e $LIB
exit 0
