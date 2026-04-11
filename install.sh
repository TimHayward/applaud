#!/bin/sh
# applaud installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/rsteckler/applaud/main/install.sh | sh
#
# What it does:
#   1. Installs pnpm (via the official installer) if not already present.
#   2. Ensures Node.js >= 20 is available (installs via pnpm if missing).
#   3. Clones the applaud repo into ./applaud (or $APPLAUD_DIR).
#   4. Runs `pnpm install` and `pnpm build`.
#   5. Prints the commands to start applaud.
set -eu

REPO_URL="${APPLAUD_REPO:-https://github.com/rsteckler/applaud.git}"
INSTALL_DIR="${APPLAUD_DIR:-$PWD/applaud}"
MIN_NODE_MAJOR=20

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

detect_os() {
  case "$(uname -s)" in
    Darwin) echo "macos" ;;
    Linux)
      if grep -qi microsoft /proc/version 2>/dev/null; then echo "wsl"
      else echo "linux"
      fi
      ;;
    *) echo "unknown" ;;
  esac
}

ensure_git() {
  if ! have git; then
    fail "git is required but not installed. Install git and re-run."
  fi
}

ensure_pnpm() {
  if have pnpm; then
    say "pnpm already installed ($(pnpm --version))"
    return
  fi
  say "installing pnpm via get.pnpm.io"
  curl -fsSL https://get.pnpm.io/install.sh | sh -
  # The pnpm installer writes to ~/.local/share/pnpm and updates the user's
  # shell rc. It won't be on PATH for this process, so source-load it.
  export PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"
  export PATH="$PNPM_HOME:$PATH"
  if ! have pnpm; then
    fail "pnpm installation finished but the binary isn't on PATH. Open a new terminal and re-run."
  fi
  say "pnpm installed ($(pnpm --version))"
}

ensure_node() {
  if have node; then
    NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if [ "$NODE_MAJOR" -ge "$MIN_NODE_MAJOR" ] 2>/dev/null; then
      say "node $(node --version) detected"
      return
    fi
    warn "node $(node --version) is too old (need >= $MIN_NODE_MAJOR)"
  fi
  say "installing Node LTS via pnpm"
  pnpm env use --global lts
  if ! have node; then
    # pnpm's env manager writes to the same PNPM_HOME dir.
    export PATH="$PNPM_HOME:$PATH"
  fi
  if ! have node; then
    fail "node is still not on PATH after pnpm env install. Open a new terminal and re-run."
  fi
  say "node $(node --version) installed"
}

clone_repo() {
  if [ -d "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
    if [ -d "$INSTALL_DIR/.git" ]; then
      say "updating existing checkout at $INSTALL_DIR"
      git -C "$INSTALL_DIR" pull --ff-only || fail "git pull failed in $INSTALL_DIR"
      return
    fi
    fail "$INSTALL_DIR exists and is not empty. Set APPLAUD_DIR to a different path, or remove it."
  fi
  say "cloning $REPO_URL into $INSTALL_DIR"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
}

install_and_build() {
  say "installing dependencies (pnpm install)"
  (cd "$INSTALL_DIR" && pnpm install)
  say "building (pnpm build)"
  (cd "$INSTALL_DIR" && pnpm build)
}

print_next_steps() {
  cat <<EOF

\033[1;32m✓ applaud installed at $INSTALL_DIR\033[0m

To start:
    cd $INSTALL_DIR
    pnpm start

Your browser will open to the setup wizard. You can also navigate to
http://127.0.0.1:7528/setup manually if it doesn't open automatically.

EOF
}

main() {
  OS="$(detect_os)"
  if [ "$OS" = "unknown" ]; then
    fail "unsupported OS. applaud supports macOS, Linux, and WSL."
  fi
  say "installing applaud (os: $OS)"
  ensure_git
  ensure_pnpm
  ensure_node
  clone_repo
  install_and_build
  print_next_steps
}

main "$@"
