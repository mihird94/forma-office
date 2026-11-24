#!/usr/bin/env bash
set -euo pipefail

# Stage a truly self-contained arm64 Metal llama-server + EmbeddingGemma 2 GGUF
# inside ~/Library/Application Support/FormaOffice/{bin,models} so all 6 Forma apps
# share one zero-Ollama, zero-Python multimodal Text + Vision embedding engine.

FORMA_DIR="$HOME/Library/Application Support/FormaOffice"
BIN_DIR="$FORMA_DIR/bin"
MODELS_DIR="$FORMA_DIR/models"

mkdir -p "$BIN_DIR" "$MODELS_DIR"

LLAMA_SRC="${LLAMA_SERVER_PATH:-$(command -v llama-server || true)}"
if [ -n "$LLAMA_SRC" ] && [ -x "$LLAMA_SRC" ]; then
  echo "==> Staging self-contained llama-server into $BIN_DIR..."
  LLAMA_REAL="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$LLAMA_SRC" 2>/dev/null || readlink -f "$LLAMA_SRC" 2>/dev/null || echo "$LLAMA_SRC")"
  LLAMA_CELLAR_LIB="$(dirname "$(dirname "$LLAMA_REAL")")/lib"

  cp -f "$LLAMA_REAL" "$BIN_DIR/llama-server"
  chmod 755 "$BIN_DIR/llama-server"

  # Copy all llama.cpp + ggml + recursive non-system dylibs into $BIN_DIR and rewrite to @loader_path
  python3 - "$BIN_DIR" "$LLAMA_CELLAR_LIB" <<'PY'
import os, shutil, subprocess, sys

bin_dir = sys.argv[1]
cellar_lib = sys.argv[2]

search_dirs = [
    cellar_lib,
    "/opt/homebrew/opt/llama.cpp/lib",
    "/opt/homebrew/opt/ggml/lib",
    "/opt/homebrew/opt/openssl@4/lib",
    "/opt/homebrew/opt/openssl@3/lib",
    "/opt/homebrew/opt/libomp/lib",
    "/opt/homebrew/lib",
]

def list_deps(path):
    out = subprocess.check_output(["otool", "-L", path], text=True)
    deps = []
    for line in out.splitlines()[1:]:
        dep = line.strip().split(" ")[0]
        if not dep or dep.startswith("/System/") or dep.startswith("/usr/lib/"):
            continue
        deps.append(dep)
    return deps

def resolve_dep(dep):
    if dep.startswith("/") and os.path.exists(dep):
        return os.path.realpath(dep)
    base = os.path.basename(dep)
    for d in search_dirs:
        cand = os.path.join(d, base)
        if os.path.exists(cand):
            return os.path.realpath(cand)
    return None

# Also include dynamic ggml Metal/CPU backend plugins loaded via dlopen if present
extra_globs = []
for d in [cellar_lib, "/opt/homebrew/opt/ggml/lib"]:
    if os.path.isdir(d):
        for name in os.listdir(d):
            if name.startswith("libggml") and name.endswith(".dylib") and not os.path.islink(os.path.join(d, name)):
                extra_globs.append(os.path.join(d, name))

queue = [os.path.join(bin_dir, "llama-server")]
visited = set()

for extra in extra_globs:
    base = os.path.basename(extra)
    dst = os.path.join(bin_dir, base)
    if not os.path.exists(dst):
        shutil.copy2(extra, dst)
        os.chmod(dst, 0o755)
    queue.append(dst)

while queue:
    target = queue.pop(0)
    if target in visited:
        continue
    visited.add(target)
    deps = list_deps(target)
    for dep in deps:
        base = os.path.basename(dep)
        if base == os.path.basename(target):
            continue
        dst = os.path.join(bin_dir, base)
        if not os.path.exists(dst):
            src = resolve_dep(dep)
            if src:
                shutil.copy2(src, dst)
                os.chmod(dst, 0o755)
                queue.append(dst)
        new_ref = f"@loader_path/{base}"
        if dep != new_ref:
            subprocess.run(["install_name_tool", "-change", dep, new_ref, target], check=False)
    if target.endswith(".dylib"):
        subprocess.run(["install_name_tool", "-id", f"@loader_path/{os.path.basename(target)}", target], check=False)

# Ensure @loader_path rpath on llama-server and ad-hoc sign everything
subprocess.run(["install_name_tool", "-add_rpath", "@loader_path", os.path.join(bin_dir, "llama-server")], stderr=subprocess.DEVNULL, check=False)
for name in sorted(os.listdir(bin_dir)):
    p = os.path.join(bin_dir, name)
    if os.path.isfile(p):
        subprocess.run(["codesign", "--force", "--sign", "-", p], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)

print(f"Staged self-contained runtime ({len(visited)} binaries/dylibs) in {bin_dir}")
PY
else
  echo "Note: llama-server not found in PATH; install via 'brew install llama.cpp' or copy llama-server into $BIN_DIR"
fi

# Verify the publisher's SHA-256 for embedding + reranker artifacts before accepting or installing them.
download_verified_model() {
  local BASE_URL="$1"
  local FILE="$2"
  local HASH="$3"
  local DEST="$MODELS_DIR/$FILE"
  if [ -f "$DEST" ] && printf '%s  %s\n' "$HASH" "$DEST" | shasum -a 256 --check --status; then
    echo "==> Model already cached: $FILE ($(du -h "$DEST" | cut -f1))"
  else
    echo "==> Downloading $FILE into $MODELS_DIR..."
    local PART
    PART="$(mktemp "$MODELS_DIR/.download.XXXXXX")"
    trap 'rm -f "$PART"' RETURN
    curl -fL --proto '=https' --proto-redir '=https' --progress-bar "$BASE_URL/$FILE" -o "$PART"
    if ! printf '%s  %s\n' "$HASH" "$PART" | shasum -a 256 --check --status; then
      echo "Checksum verification failed for $FILE" >&2
      return 1
    fi
    mv "$PART" "$DEST"
    trap - RETURN
  fi
}

EMBED_BASE_URL="https://huggingface.co/ggml-org/embeddinggemma-2-GGUF/resolve/main"
download_verified_model "$EMBED_BASE_URL" "embeddinggemma-2-Q8_0.gguf" "2188ac1deca4b77dffefd603c2776a9d76d9d74ec01841392982ebb840b09135"
download_verified_model "$EMBED_BASE_URL" "mmproj-embeddinggemma-2-Q8_0.gguf" "0531309472a6bc6f4b146c3736eee7795ec9db1903c25490d3c937490cef6dd8"

RERANK_BASE_URL="https://huggingface.co/gpustack/jina-reranker-v1-turbo-en-GGUF/resolve/main"
download_verified_model "$RERANK_BASE_URL" "jina-reranker-v1-turbo-en-Q8_0.gguf" "6633027dd42a9490313504ce698dcd8bbd44f8694e58ab555e2d06d8535f4f86"

echo "==> Done! Self-contained Forma EmbeddingGemma 2 + Cross-Encoder Reranker runtime is ready."
