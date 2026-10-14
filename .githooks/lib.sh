# shellcheck shell=sh
# Shared helpers for the git hooks in this directory. Sourced, not executed.
# Git only runs files whose names match hook names, so this file is never run as a hook.

# Ensure `node`, `npm` and `npx` are on PATH.
#
# Terminal commits normally inherit PATH from the shell (including nvm). GUI git
# clients and IDEs often do not load the shell profile, so fall back to loading
# nvm (honouring .nvmrc) before giving up with a clear message.
ensure_node() {
	if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
		return 0
	fi

	_nvm_dir="${NVM_DIR:-$HOME/.nvm}"
	if [ -s "$_nvm_dir/nvm.sh" ]; then
		# shellcheck disable=SC1091
		. "$_nvm_dir/nvm.sh" >/dev/null 2>&1 || true
		if command -v nvm >/dev/null 2>&1; then
			nvm use --silent >/dev/null 2>&1 || nvm use --silent default >/dev/null 2>&1 || true
		fi
	fi

	if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
		return 0
	fi

	cat >&2 <<'MSG'
git hook error: Node.js (node/npm) was not found on PATH.

These hooks need Node 24 (see .nvmrc). Fix one of:
  - install Node, or run `nvm install && nvm use` in this repo
  - make sure your git client inherits the PATH that contains node
  - bypass once (not recommended): git commit --no-verify
MSG
	exit 1
}

# Ensure dev dependencies are installed so the hook can run local binaries.
ensure_deps() {
	if [ ! -d node_modules ]; then
		echo "git hook error: node_modules is missing. Run \`npm install\` first." >&2
		exit 1
	fi
}
