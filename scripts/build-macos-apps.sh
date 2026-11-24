#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$ROOT_DIR/macos/build"
INSTALL_DIR="/Applications"
INDEXER_DIR="$HOME/Library/Application Support/FormaOffice/bin"

echo "==> 1. Building production web bundle (Vite)..."
cd "$ROOT_DIR"
npm run build

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

echo "==> 2. Compiling native arm64 Swift host binary..."
HOST_BIN="$BUILD_DIR/FormaHost"
xcrun clang -O2 -arch arm64 -mmacosx-version-min=13.0 -c "$ROOT_DIR/macos/FormaSocketHTTP.c" -o "$BUILD_DIR/FormaSocketHTTP.o"
SWIFT_FLAGS=(-O -parse-as-library -target arm64-apple-macos13.0 -module-cache-path "$BUILD_DIR/module-cache" -import-objc-header "$ROOT_DIR/macos/FormaSocketHTTP.h")
INDEX_SOURCES=(
  "$ROOT_DIR/macos/FormaSemanticIndex.swift"
  "$ROOT_DIR/macos/FormaIndexConfig.swift"
  "$ROOT_DIR/macos/FormaDocExtractors.swift"
)
INDEX_LIBS=("$BUILD_DIR/FormaSocketHTTP.o" -framework Vision -framework PDFKit -framework CryptoKit -framework UniformTypeIdentifiers -framework Accelerate -lsqlite3 -lcurl)
swiftc "${SWIFT_FLAGS[@]}" "$ROOT_DIR/macos/FormaHost.swift" "${INDEX_SOURCES[@]}" \
  "${INDEX_LIBS[@]}" -framework Cocoa -framework WebKit -o "$HOST_BIN"

echo "==> Compiling and signing forma-indexer..."
swiftc "${SWIFT_FLAGS[@]}" "$ROOT_DIR/macos/FormaIndexerCLI.swift" "$ROOT_DIR/macos/FormaIndexWatch.swift" \
  "${INDEX_SOURCES[@]}" "${INDEX_LIBS[@]}" -framework CoreServices -o "$BUILD_DIR/forma-indexer"
codesign --force --sign - "$BUILD_DIR/forma-indexer"

echo "==> Compiling native arm64 Forma Search menu bar launcher..."
SEARCH_BIN="$BUILD_DIR/FormaSearch"
swiftc "${SWIFT_FLAGS[@]}" "$ROOT_DIR/macos/FormaSpotlight.swift" "${INDEX_SOURCES[@]}" \
  "${INDEX_LIBS[@]}" -framework Cocoa -framework Carbon -o "$SEARCH_BIN"

build_app() {
  local KIND="$1"         # sheets | docs
  local APP_NAME="$2"     # "Forma Sheets" | "Forma Docs"
  local EXEC_NAME="$3"    # FormaSheets | FormaDocs
  local BUNDLE_ID="$4"    # com.formaoffice.sheets | com.formaoffice.docs
  local DOC_TYPES_XML="$5"

  echo "==> 3. Generating native macOS AppIcon for $APP_NAME..."
  local ICONSET="$BUILD_DIR/${EXEC_NAME}.iconset"
  local ICNS="$BUILD_DIR/${EXEC_NAME}.icns"
  swift -module-cache-path "$BUILD_DIR/module-cache" "$ROOT_DIR/macos/GenerateIcons.swift" "$KIND" "$ICONSET"
  iconutil -c icns "$ICONSET" -o "$ICNS"

  echo "==> 4. Assembling ${APP_NAME}.app bundle..."
  local APP_BUNDLE="$BUILD_DIR/${APP_NAME}.app"
  mkdir -p "$APP_BUNDLE/Contents/MacOS"
  mkdir -p "$APP_BUNDLE/Contents/Resources/web"

  cp "$HOST_BIN" "$APP_BUNDLE/Contents/MacOS/$EXEC_NAME"
  chmod +x "$APP_BUNDLE/Contents/MacOS/$EXEC_NAME"
  cp "$ICNS" "$APP_BUNDLE/Contents/Resources/AppIcon.icns"
  cp -R "$ROOT_DIR/dist/." "$APP_BUNDLE/Contents/Resources/web/"
  cp "$ROOT_DIR/macos/forma_kernel.py" "$APP_BUNDLE/Contents/Resources/forma_kernel.py"
  chmod +x "$APP_BUNDLE/Contents/Resources/forma_kernel.py"

  local EXTRA_PLIST_XML=""
  if [ "$KIND" = "lab" ]; then
    EXTRA_PLIST_XML='  <key>UTExportedTypeDeclarations</key>
  <array>
    <dict>
      <key>UTTypeIdentifier</key><string>org.jupyter.notebook</string>
      <key>UTTypeDescription</key><string>Jupyter Notebook</string>
      <key>UTTypeConformsTo</key><array><string>public.json</string><string>public.data</string></array>
      <key>UTTypeTagSpecification</key>
      <dict>
        <key>public.filename-extension</key><array><string>ipynb</string></array>
        <key>public.mime-type</key><array><string>application/x-ipynb+json</string></array>
      </dict>
    </dict>
  </array>'
  elif [ "$KIND" = "canvas" ]; then
    EXTRA_PLIST_XML='  <key>UTExportedTypeDeclarations</key>
  <array>
    <dict>
      <key>UTTypeIdentifier</key><string>com.formaoffice.canvas-board</string>
      <key>UTTypeDescription</key><string>Forma Canvas Board</string>
      <key>UTTypeConformsTo</key><array><string>public.json</string><string>public.data</string></array>
      <key>UTTypeTagSpecification</key>
      <dict>
        <key>public.filename-extension</key><array><string>fcanvas</string></array>
        <key>public.mime-type</key><array><string>application/json</string></array>
      </dict>
    </dict>
    <dict>
      <key>UTTypeIdentifier</key><string>com.excalidraw.drawing</string>
      <key>UTTypeDescription</key><string>Excalidraw Drawing</string>
      <key>UTTypeConformsTo</key><array><string>public.json</string><string>public.data</string></array>
      <key>UTTypeTagSpecification</key>
      <dict>
        <key>public.filename-extension</key><array><string>excalidraw</string></array>
        <key>public.mime-type</key><array><string>application/json</string></array>
      </dict>
    </dict>
  </array>'
  fi

  cat > "$APP_BUNDLE/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>${APP_NAME}</string>
  <key>CFBundleExecutable</key>
  <string>${EXEC_NAME}</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>${BUNDLE_ID}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${APP_NAME}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>FormaAppKind</key>
  <string>${KIND}</string>
  <key>CFBundleDocumentTypes</key>
  <array>
${DOC_TYPES_XML}
  </array>
${EXTRA_PLIST_XML}
</dict>
</plist>
EOF

  echo "==> 5. Ad-hoc signing ${APP_NAME}.app..."
  codesign --force --deep --sign - "$APP_BUNDLE"

}

SHEETS_DOC_TYPES='    <dict>
      <key>CFBundleTypeName</key><string>Excel Open XML Spreadsheet</string>
      <key>CFBundleTypeRole</key><string>Editor</string>
      <key>LSHandlerRank</key><string>Alternate</string>
      <key>LSItemContentTypes</key><array><string>org.openxmlformats.spreadsheetml.sheet</string></array>
      <key>CFBundleTypeExtensions</key><array><string>xlsx</string></array>
    </dict>
    <dict>
      <key>CFBundleTypeName</key><string>OpenDocument Spreadsheet</string>
      <key>CFBundleTypeRole</key><string>Editor</string>
      <key>LSHandlerRank</key><string>Alternate</string>
      <key>LSItemContentTypes</key><array><string>org.oasis-open.opendocument.spreadsheet</string></array>
      <key>CFBundleTypeExtensions</key><array><string>ods</string></array>
    </dict>
    <dict>
      <key>CFBundleTypeName</key><string>Comma-Separated Values</string>
      <key>CFBundleTypeRole</key><string>Editor</string>
      <key>LSHandlerRank</key><string>Alternate</string>
      <key>LSItemContentTypes</key><array><string>public.comma-separated-values-text</string><string>public.tab-separated-values-text</string></array>
      <key>CFBundleTypeExtensions</key><array><string>csv</string><string>tsv</string></array>
    </dict>'

DOCS_DOC_TYPES='    <dict>
      <key>CFBundleTypeName</key><string>Word Open XML Document</string>
      <key>CFBundleTypeRole</key><string>Editor</string>
      <key>LSHandlerRank</key><string>Alternate</string>
      <key>LSItemContentTypes</key><array><string>org.openxmlformats.wordprocessingml.document</string></array>
      <key>CFBundleTypeExtensions</key><array><string>docx</string></array>
    </dict>
    <dict>
      <key>CFBundleTypeName</key><string>OpenDocument Text</string>
      <key>CFBundleTypeRole</key><string>Editor</string>
      <key>LSHandlerRank</key><string>Alternate</string>
      <key>LSItemContentTypes</key><array><string>org.oasis-open.opendocument.text</string></array>
      <key>CFBundleTypeExtensions</key><array><string>odt</string></array>
    </dict>
    <dict>
      <key>CFBundleTypeName</key><string>Markdown Document</string>
      <key>CFBundleTypeRole</key><string>Editor</string>
      <key>LSHandlerRank</key><string>Alternate</string>
      <key>LSItemContentTypes</key><array><string>net.daringfireball.markdown</string></array>
      <key>CFBundleTypeExtensions</key><array><string>md</string><string>markdown</string></array>
    </dict>
    <dict>
      <key>CFBundleTypeName</key><string>HTML Document</string>
      <key>CFBundleTypeRole</key><string>Editor</string>
      <key>LSHandlerRank</key><string>Alternate</string>
      <key>LSItemContentTypes</key><array><string>public.html</string></array>
      <key>CFBundleTypeExtensions</key><array><string>html</string><string>htm</string></array>
    </dict>'

SLIDES_DOC_TYPES='    <dict>
      <key>CFBundleTypeName</key><string>PowerPoint Open XML Presentation</string>
      <key>CFBundleTypeRole</key><string>Editor</string>
      <key>LSHandlerRank</key><string>Alternate</string>
      <key>LSItemContentTypes</key><array><string>org.openxmlformats.presentationml.presentation</string></array>
      <key>CFBundleTypeExtensions</key><array><string>pptx</string></array>
    </dict>
    <dict>
      <key>CFBundleTypeName</key><string>OpenDocument Presentation</string>
      <key>CFBundleTypeRole</key><string>Editor</string>
      <key>LSHandlerRank</key><string>Alternate</string>
      <key>LSItemContentTypes</key><array><string>org.oasis-open.opendocument.presentation</string></array>
      <key>CFBundleTypeExtensions</key><array><string>odp</string></array>
    </dict>'

PDF_DOC_TYPES='    <dict>
      <key>CFBundleTypeName</key><string>Portable Document Format (PDF)</string>
      <key>CFBundleTypeRole</key><string>Editor</string>
      <key>LSHandlerRank</key><string>Alternate</string>
      <key>LSItemContentTypes</key><array><string>com.adobe.pdf</string></array>
      <key>CFBundleTypeExtensions</key><array><string>pdf</string></array>
    </dict>'

LAB_DOC_TYPES='    <dict>
      <key>CFBundleTypeName</key><string>Jupyter Notebook</string>
      <key>CFBundleTypeRole</key><string>Editor</string>
      <key>LSHandlerRank</key><string>Alternate</string>
      <key>LSItemContentTypes</key><array><string>org.jupyter.notebook</string><string>public.json</string></array>
      <key>CFBundleTypeExtensions</key><array><string>ipynb</string></array>
    </dict>
    <dict>
      <key>CFBundleTypeName</key><string>Notebook Project Folder</string>
      <key>CFBundleTypeRole</key><string>Viewer</string>
      <key>LSHandlerRank</key><string>Alternate</string>
      <key>LSItemContentTypes</key><array><string>public.folder</string></array>
    </dict>'

CANVAS_DOC_TYPES='    <dict>
      <key>CFBundleTypeName</key><string>Forma Canvas Board</string>
      <key>CFBundleTypeRole</key><string>Editor</string>
      <key>LSHandlerRank</key><string>Owner</string>
      <key>LSItemContentTypes</key><array><string>com.formaoffice.canvas-board</string><string>public.json</string></array>
      <key>CFBundleTypeExtensions</key><array><string>fcanvas</string></array>
    </dict>
    <dict>
      <key>CFBundleTypeName</key><string>Excalidraw Drawing</string>
      <key>CFBundleTypeRole</key><string>Editor</string>
      <key>LSHandlerRank</key><string>Alternate</string>
      <key>LSItemContentTypes</key><array><string>com.excalidraw.drawing</string><string>public.json</string></array>
      <key>CFBundleTypeExtensions</key><array><string>excalidraw</string></array>
    </dict>'

build_app "sheets" "Forma Sheets" "FormaSheets" "com.formaoffice.sheets" "$SHEETS_DOC_TYPES"
build_app "docs"   "Forma Docs"   "FormaDocs"   "com.formaoffice.docs"   "$DOCS_DOC_TYPES"
build_app "slides" "Forma Slides" "FormaSlides" "com.formaoffice.slides" "$SLIDES_DOC_TYPES"
build_app "pdf"    "Forma PDF"    "FormaPDF"    "com.formaoffice.pdf"    "$PDF_DOC_TYPES"
build_app "lab"    "Forma Lab"    "FormaLab"    "com.formaoffice.lab"    "$LAB_DOC_TYPES"
build_app "canvas" "Forma Canvas" "FormaCanvas" "com.formaoffice.canvas" "$CANVAS_DOC_TYPES"

build_search_app() {
  local APP_NAME="Forma Search"
  local EXEC_NAME="FormaSearch"
  local BUNDLE_ID="com.formaoffice.search"

  echo "==> 3. Generating native macOS AppIcon for $APP_NAME..."
  local ICONSET="$BUILD_DIR/${EXEC_NAME}.iconset"
  local ICNS="$BUILD_DIR/${EXEC_NAME}.icns"
  swift -module-cache-path "$BUILD_DIR/module-cache" "$ROOT_DIR/macos/GenerateIcons.swift" "search" "$ICONSET"
  iconutil -c icns "$ICONSET" -o "$ICNS"

  echo "==> 4. Assembling ${APP_NAME}.app bundle..."
  local APP_BUNDLE="$BUILD_DIR/${APP_NAME}.app"
  mkdir -p "$APP_BUNDLE/Contents/MacOS"
  mkdir -p "$APP_BUNDLE/Contents/Resources"

  cp "$SEARCH_BIN" "$APP_BUNDLE/Contents/MacOS/$EXEC_NAME"
  chmod +x "$APP_BUNDLE/Contents/MacOS/$EXEC_NAME"
  cp "$ICNS" "$APP_BUNDLE/Contents/Resources/AppIcon.icns"

  cat > "$APP_BUNDLE/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>${APP_NAME}</string>
  <key>CFBundleExecutable</key>
  <string>${EXEC_NAME}</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>${BUNDLE_ID}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${APP_NAME}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
EOF

  echo "==> 5. Ad-hoc signing ${APP_NAME}.app..."
  codesign --force --deep --sign - "$APP_BUNDLE"
}

build_search_app

install_apps() (
  local app target
  local names=("Forma Sheets.app" "Forma Docs.app" "Forma Slides.app" "Forma PDF.app" "Forma Lab.app" "Forma Canvas.app" "Forma Search.app")
  local staged pending_cli
  staged="$(mktemp -d "$INSTALL_DIR/.forma-install.XXXXXX")"
  pending_cli="$INDEXER_DIR/.forma-indexer.$$"
  mkdir -p "$staged/new" "$staged/previous"
  rollback() {
    local status="$?"
    trap - EXIT
    if [ "$status" -ne 0 ]; then
      for app in "${names[@]}"; do
        target="$INSTALL_DIR/$app"
        if [ ! -e "$staged/new/$app" ] && [ -e "$target" ] && [ -f "$staged/ready" ]; then
          mv "$target" "$staged/new/$app" || continue
        fi
        if [ -e "$staged/previous/$app" ]; then mv "$staged/previous/$app" "$target" || true; fi
      done
      rm -f "$pending_cli"
      echo "Installation failed. Staged and previous bundles are in $staged" >&2
    fi
    exit "$status"
  }
  trap rollback EXIT
  mkdir -p "$INDEXER_DIR"
  install -m 0755 "$BUILD_DIR/forma-indexer" "$pending_cli"
  codesign --verify --strict "$pending_cli"
  for app in "${names[@]}"; do
    cp -R "$BUILD_DIR/$app" "$staged/new/$app"
    codesign --verify --deep --strict "$staged/new/$app"
  done
  touch "$staged/ready"
  for app in "${names[@]}"; do
    target="$INSTALL_DIR/$app"
    if [ -e "$target" ]; then mv "$target" "$staged/previous/$app"; fi
    mv "$staged/new/$app" "$target"
    codesign --verify --deep --strict "$target"
  done
  mv -f "$pending_cli" "$INDEXER_DIR/forma-indexer"
  trap - EXIT
  mv "$staged/previous" "$BUILD_DIR/previous-apps" || echo "Previous bundles are in $staged/previous"
  rm -f "$staged/ready"
  rmdir "$staged/new" "$staged" 2>/dev/null || true
)

echo "==> 6. Installing the seven verified macOS bundles and forma-indexer..."
install_apps

echo ""
echo "Installed compiled native macOS apps:"
du -sh "/Applications/Forma Sheets.app" "/Applications/Forma Docs.app" "/Applications/Forma Slides.app" "/Applications/Forma PDF.app" "/Applications/Forma Lab.app" "/Applications/Forma Canvas.app" "/Applications/Forma Search.app"
