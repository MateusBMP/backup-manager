#!/usr/bin/env bash
# Live install and uninstall for `make install` / `make uninstall` (no package
# manager). Run by the Makefile as root.
#
#   manifest.sh install STAGE    copy the staged tree STAGE into /, recording every
#                                path; an upgrade replaces the previous install
#   manifest.sh uninstall        remove exactly the recorded paths
#
# Install is all-or-nothing: before anything is copied it refuses paths that a
# package or the admin owns; if a copy fails, the files are put back as they were
# (the previous version on an upgrade, nothing on a first install).
#
# backup-manager has no system service. Each user's bkm.service (a systemd user
# unit written by the UI), config and backups are theirs: nothing here touches them.
set -Eeuo pipefail   # -E: the rollback trap also fires inside functions
umask 022

NAME=backup-manager
MANIFEST=/var/lib/$NAME-install.manifest
LIB=/usr/lib/$NAME

log() { echo "manifest.sh: $*" >&2; }
die() { log "$*"; exit 1; }
[[ $(id -u) -eq 0 ]] || die "run as root"

# Owned by a package? (dpkg, pacman or rpm, whichever exists)
packaged() {
    { command -v dpkg >/dev/null && dpkg -S "$1" >/dev/null 2>&1; } ||
    { command -v pacman >/dev/null && pacman -Qoq "$1" >/dev/null 2>&1; } ||
    { command -v rpm >/dev/null && rpm -qf "$1" >/dev/null 2>&1; }
}

selinux_label() {  # selinux_label MANIFEST: the labels the policy gives, whatever the copy left
    command -v selinuxenabled >/dev/null && selinuxenabled || return 0
    grep -v '/$' "$1" | xargs -r -d '\n' restorecon -F
}

restart_hint() {
    echo "A running service keeps the previous code until it is restarted; each user runs:"
    echo "  systemctl --user restart bkm"
}

cmd_install() {
    local stage=${1:?usage: manifest.sh install STAGE}
    [[ -f $stage$LIB/dist/cli.js ]] || die "$stage is not a staged tree (make install-files DESTDIR=...)"
    stage=$(cd "$stage" && pwd)

    local -A old=()
    local p
    if [[ -f $MANIFEST ]]; then
        while IFS= read -r p; do [[ -n $p ]] && old[$p]=1; done <"$MANIFEST"
    fi

    # The new set: files and the directories they need (directories end in /).
    local -a files=() dirs=()
    while IFS= read -r p; do files+=("${p#.}"); done < <(cd "$stage" && find . \( -type f -o -type l \) | sort)
    while IFS= read -r p; do dirs+=("${p#.}/"); done < <(cd "$stage" && find . -mindepth 1 -type d | sort)

    # 1. Refuse before touching anything: a path we did not install that exists already.
    local conflicts=()
    for p in "${files[@]}"; do
        if [[ -e $p || -L $p ]] && [[ -z ${old[$p]:-} ]]; then conflicts+=("$p"); fi
    done
    if ((${#conflicts[@]})); then
        local c; for c in "${conflicts[@]:0:10}"; do
            if packaged "$c"; then log "conflict: $c belongs to a package (remove that package first)"
            else log "conflict: $c exists and was not installed by make install"; fi
        done
        die "nothing was changed"
    fi

    # 2. Copy, keeping what is replaced, so that a failure can put it back.
    local backup; backup=$(mktemp -d /var/tmp/$NAME-backup.XXXXXX)
    local -a created_files=() created_dirs=() replaced=()
    local new_manifest; new_manifest=$(mktemp "$MANIFEST.new.XXXXXX")
    rollback() {
        log "failed; rolling back"
        local f
        for f in "${replaced[@]}"; do cp -a "$backup$f" "$f" 2>/dev/null || log "could not restore $f"; done
        for f in "${created_files[@]}"; do rm -f -- "$f"; done
        local i; for ((i = ${#created_dirs[@]} - 1; i >= 0; i--)); do rmdir -- "${created_dirs[$i]}" 2>/dev/null || true; done
        rm -rf "$backup" "$new_manifest"
        exit 1
    }
    trap rollback ERR INT TERM

    for p in "${dirs[@]}"; do
        local d=${p%/}
        if [[ ! -d $d ]]; then
            mkdir -m 0755 "$d"
            created_dirs+=("$d")
            echo "$p" >>"$new_manifest"
        elif [[ -n ${old[$p]:-} ]]; then
            echo "$p" >>"$new_manifest"   # ours from before: still ours
        fi
    done
    for p in "${files[@]}"; do
        if [[ -e $p || -L $p ]]; then
            mkdir -p "$backup$(dirname "$p")"; cp -a "$p" "$backup$p"; replaced+=("$p")
        else
            created_files+=("$p")
        fi
        # Write next to the target, then rename: a running job never sees half a file.
        # Not cp -a: that keeps the staging directory's SELinux label (selinux_label relabels too).
        cp -P --preserve=mode,timestamps "$stage$p" "$p.$NAME-tmp"
        chown -h root:root "$p.$NAME-tmp"
        mv -f "$p.$NAME-tmp" "$p"
        echo "$p" >>"$new_manifest"
    done
    selinux_label "$new_manifest"
    trap - ERR INT TERM

    # 3. Committed: drop what the previous version had and this one has not.
    local -A now=()
    while IFS= read -r p; do now[$p]=1; done <"$new_manifest"
    for p in "${!old[@]}"; do
        [[ -n ${now[$p]:-} || $p == */ ]] && continue
        rm -f -- "$p"
    done
    for p in $(printf '%s\n' "${!old[@]}" | grep '/$' | sort -r); do
        [[ -n ${now[$p]:-} ]] || rmdir -- "${p%/}" 2>/dev/null || true
    done
    sort -u "$new_manifest" >"$MANIFEST.tmp" && mv -f "$MANIFEST.tmp" "$MANIFEST"
    rm -f "$new_manifest"; rm -rf "$backup"
    chmod 0644 "$MANIFEST"
    echo "installed $NAME ($(grep -vc '/$' "$MANIFEST") files; manifest $MANIFEST)"
    if ((${#old[@]})); then restart_hint
    else echo "Run 'bkm' as the user who will own the backups: the UI creates the config and installs the service."
    fi
}

cmd_uninstall() {
    [[ -f $MANIFEST ]] || die "no $MANIFEST: nothing installed by make install"
    local p
    # Files first, then directories deepest first; a directory that is not empty stays.
    while IFS= read -r p; do
        [[ -n $p && $p != */ ]] && rm -f -- "$p"
    done <"$MANIFEST"
    for p in $(grep '/$' "$MANIFEST" | sort -r); do rmdir -- "${p%/}" 2>/dev/null || true; done
    rm -f "$MANIFEST"
    echo "uninstalled $NAME (configs, backups and job history are kept)"
    echo "A user who installed the service still has ~/.config/systemd/user/bkm.service; they remove it with:"
    echo "  systemctl --user disable --now bkm && rm ~/.config/systemd/user/bkm.service && systemctl --user daemon-reload"
}

case ${1:-} in
    install) shift; cmd_install "$@" ;;
    uninstall) cmd_uninstall ;;
    *) sed -n '2,/^set -Eeuo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 2 ;;
esac
