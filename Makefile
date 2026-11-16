# backup-manager: build, install and uninstall without npm's global prefix.
#
#   make                         build bundle/: the program (dist/cli.js) and its runtime
#                                dependencies (node_modules, production only)
#   make check                   the test suite (npm run verify)
#   make install DESTDIR=DIR     stage the files under DIR (packages: PKGBUILD, debian/rules)
#   sudo make install            install into the running system, with a manifest and
#                                rollback (packaging/manifest.sh)
#   sudo make uninstall          remove exactly the installed files (configs, backups and
#                                each user's bkm.service are kept)
#   make dist                    release tarball of the working tree, bundle/ included
#                                (backup-manager-VERSION.tar.gz)
#   make arch-pkg                the Arch package from that tarball (packaging/arch, makepkg)
#
# Building needs Node.js >= 22, npm and the npm registry. A release tarball carries
# bundle/ already built, so `make install` from it needs neither npm nor the network,
# only Node.js >= 22 at run time. The packages are built from that tarball.

NAME        := backup-manager
VERSION     := $(shell sed -n 's/^  "version": "\(.*\)",$$/\1/p' package.json | head -n 1)
NPM         ?= npm

PREFIX      ?= /usr
LIBDIR      := $(PREFIX)/lib/$(NAME)
BINDIR      := $(PREFIX)/bin
DATADIR     := $(PREFIX)/share
# Empty: no licence or doc files (Debian ships them itself: debian/copyright, debian/*.docs).
LICENSEDIR  ?= $(DATADIR)/licenses/$(NAME)
DOCDIR      ?= $(DATADIR)/doc/$(NAME)

BUNDLE      := bundle
SOURCES     := $(shell find src -type f | sort) package.json package-lock.json tsconfig.json tsup.config.ts \
               config.schema.json config.example.json scripts/third-party-licenses.mjs

INSTALL     ?= install
STAGE_TMP   := $(shell mktemp -u /tmp/$(NAME)-stage.XXXXXX)

.PHONY: all build check install install-files uninstall dist arch-pkg clean

all: build

build: $(BUNDLE)/.stamp

# The bundle is what gets installed: nothing else of the tree is needed at run time.
# Type declarations and source maps of the dependencies are left out; licence files stay,
# and THIRD-PARTY-LICENSES.txt lists every library with its licence text.
$(BUNDLE)/.stamp: $(SOURCES)
	@command -v $(NPM) >/dev/null || { \
	    echo "make: $(BUNDLE)/ is missing or older than the sources, and npm is not installed." >&2; \
	    echo "      Install Node.js >= 22 with npm, or use a release tarball (bundle/ is built in it)." >&2; \
	    exit 2; }
	[ -d node_modules ] || $(NPM) ci --no-audit --no-fund
	$(NPM) run build
	rm -rf $(BUNDLE)
	mkdir -p $(BUNDLE)/dist
	cp dist/cli.js $(BUNDLE)/dist/cli.js
	cp package.json package-lock.json config.schema.json config.example.json $(BUNDLE)/
	cd $(BUNDLE) && $(NPM) ci --omit=dev --ignore-scripts --no-audit --no-fund
	rm -rf $(BUNDLE)/package-lock.json $(BUNDLE)/node_modules/.package-lock.json $(BUNDLE)/node_modules/.bin
	find $(BUNDLE)/node_modules -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \) -delete
	find $(BUNDLE)/node_modules -type d -empty -delete
	node scripts/third-party-licenses.mjs $(BUNDLE) >$(BUNDLE)/THIRD-PARTY-LICENSES.txt
	touch $@

check:
	$(NPM) run verify

ifeq ($(DESTDIR),)
# A live install: stage, then copy with a manifest and rollback.
install: build
	@[ "$$(id -u)" -eq 0 ] || { echo "make install: run as root (or set DESTDIR to stage)" >&2; exit 2; }
	$(MAKE) --no-print-directory install-files DESTDIR=$(STAGE_TMP)
	bash packaging/manifest.sh install $(STAGE_TMP); rc=$$?; rm -rf $(STAGE_TMP); exit $$rc
else
install: build install-files
endif

install-files:
	@[ -n "$(DESTDIR)" ] || { echo "install-files needs DESTDIR" >&2; exit 2; }
	@[ -f $(BUNDLE)/dist/cli.js ] || { echo "missing $(BUNDLE)/dist/cli.js: run make first" >&2; exit 2; }
	mkdir -p "$(DESTDIR)$(LIBDIR)" "$(DESTDIR)$(BINDIR)"
	cp -R $(BUNDLE)/dist $(BUNDLE)/node_modules "$(DESTDIR)$(LIBDIR)/"
	$(INSTALL) -m 0644 $(BUNDLE)/package.json $(BUNDLE)/config.schema.json $(BUNDLE)/config.example.json \
	    "$(DESTDIR)$(LIBDIR)/"
	find "$(DESTDIR)$(LIBDIR)" -type d -exec chmod 0755 {} +
	find "$(DESTDIR)$(LIBDIR)" -type f -exec chmod 0644 {} +
	chmod 0755 "$(DESTDIR)$(LIBDIR)/dist/cli.js"
	ln -sfn ../lib/$(NAME)/dist/cli.js "$(DESTDIR)$(BINDIR)/bkm"
ifneq ($(LICENSEDIR),)
	$(INSTALL) -D -m 0644 LICENSE "$(DESTDIR)$(LICENSEDIR)/LICENSE"
	$(INSTALL) -D -m 0644 NOTICE  "$(DESTDIR)$(LICENSEDIR)/NOTICE"
	$(INSTALL) -D -m 0644 $(BUNDLE)/THIRD-PARTY-LICENSES.txt "$(DESTDIR)$(LICENSEDIR)/THIRD-PARTY-LICENSES.txt"
endif
ifneq ($(DOCDIR),)
	$(INSTALL) -D -m 0644 README.md "$(DESTDIR)$(DOCDIR)/README.md"
	$(INSTALL) -D -m 0644 config.example.json "$(DESTDIR)$(DOCDIR)/config.example.json"
endif

uninstall:
	@[ "$$(id -u)" -eq 0 ] || { echo "make uninstall: run as root" >&2; exit 2; }
	bash packaging/manifest.sh uninstall

# The working tree, not HEAD: a package of what is being tested (no .git needed).
# bundle/ goes in, so the tarball installs without npm; the development node_modules,
# dist/ and coverage/ stay out.
dist: build
	tar --exclude-vcs --exclude=./node_modules --exclude=./dist --exclude=./coverage --exclude=./results --exclude=./release \
	    --exclude=./.claude --exclude=./.agents --exclude=./CLAUDE.md --exclude=./AGENTS.md --exclude=./debian \
	    --exclude=./config.json --exclude=./backups --exclude=./state --exclude='*.pw' --exclude='*.token' --exclude='*.tgz' --exclude='*.tsbuildinfo' \
	    --exclude='./$(NAME)-*.tar.gz' \
	    --exclude=./packaging/arch/src --exclude=./packaging/arch/pkg --exclude='*.pkg.tar.*' \
	    --exclude='./packaging/arch/$(NAME)-*.tar.gz' \
	    --transform 's,^\.,$(NAME)-$(VERSION),' -czf $(STAGE_TMP).tar.gz .
	mv -f $(STAGE_TMP).tar.gz $(NAME)-$(VERSION).tar.gz
	@echo $(NAME)-$(VERSION).tar.gz

arch-pkg: dist
	mv -f $(NAME)-$(VERSION).tar.gz packaging/arch/
	cd packaging/arch && makepkg -f $(MAKEPKG_FLAGS)

clean:
	rm -rf $(BUNDLE) dist
	rm -f $(NAME)-*.tar.gz packaging/arch/$(NAME)-*.tar.gz packaging/arch/*.pkg.tar.*
	rm -rf packaging/arch/src packaging/arch/pkg
