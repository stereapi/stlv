#!/bin/zsh
# Builds dist/stlv.app: the Swift shell + a copy of app/.
#   mac/build.sh          build
#   mac/build.sh --run    build and open
#   mac/build.sh --test   build and run the test suite headless in WebKit
set -e
cd "${0:A:h}/.."
ROOT=$PWD
OUT=$ROOT/dist/stlv.app
TMP=$(mktemp -d)
trap 'rm -rf $TMP' EXIT

# Command Line Tools bug: bridging.modulemap and module.modulemap both define
# SwiftBridging. Hide the duplicate with a VFS overlay (no system files touched).
INC=/Library/Developer/CommandLineTools/usr/include/swift
FLAGS=()
if [[ -f $INC/bridging.modulemap && -f $INC/module.modulemap ]] && grep -q "module SwiftBridging" $INC/module.modulemap; then
  : > $TMP/empty.modulemap
  print -r -- "{ \"version\": 0, \"case-sensitive\": \"false\", \"roots\": [ { \"type\": \"file\", \"name\": \"$INC/bridging.modulemap\", \"external-contents\": \"$TMP/empty.modulemap\" } ] }" > $TMP/overlay.yaml
  FLAGS=(-vfsoverlay $TMP/overlay.yaml -Xcc -ivfsoverlay -Xcc $TMP/overlay.yaml)
fi

rm -rf $OUT
mkdir -p $OUT/Contents/MacOS $OUT/Contents/Resources
swiftc -O $FLAGS -target arm64-apple-macos13.0 mac/main.swift -o $OUT/Contents/MacOS/stlv 2>&1 | grep -v ': 0:$' || true
[[ -x $OUT/Contents/MacOS/stlv ]] || { echo "swift build failed"; exit 1 }
cp mac/Info.plist $OUT/Contents/Info.plist
[[ -f mac/AppIcon.icns ]] && cp mac/AppIcon.icns $OUT/Contents/Resources/AppIcon.icns
rsync -a --delete --exclude '.DS_Store' app/ $OUT/Contents/Resources/app/
# bundled flyer fonts (OFL / Apache): Info.plist ATSApplicationFontsPath loads them for stlv only
[[ -d mac/fonts ]] && rsync -a --exclude '.DS_Store' mac/fonts/ $OUT/Contents/Resources/Fonts/

# Quick Look extensions: Finder thumbnails + spacebar previews of .stlv files,
# from the composite.png every save stores. Signed first, with the sandbox
# entitlement extensions need; the app is signed after without --deep, which
# would re-sign them and drop it.
for kind in Thumb Preview; do
  [[ $kind == Thumb ]] && { SRC=mac/ql/ThumbnailProvider.swift; FW=(-framework QuickLookThumbnailing) } || { SRC=mac/ql/PreviewProvider.swift; FW=(-framework QuickLookUI) }
  EX=$OUT/Contents/PlugIns/Stlv$kind.appex
  mkdir -p $EX/Contents/MacOS
  swiftc -O $FLAGS -target arm64-apple-macos13.0 -parse-as-library -application-extension -module-name Stlv$kind \
    $SRC mac/ql/StlvZip.swift $FW -Xlinker -e -Xlinker _NSExtensionMain -o $EX/Contents/MacOS/Stlv$kind 2>&1 | grep -v ': 0:$' || true
  [[ -x $EX/Contents/MacOS/Stlv$kind ]] || { echo "Quick Look $kind build failed"; exit 1 }
  cp mac/ql/${kind}Info.plist $EX/Contents/Info.plist
  codesign --force -s - --entitlements mac/ql/ql.entitlements $EX 2>/dev/null
done
codesign --force -s - $OUT 2>/dev/null
# let Finder / Quick Look find the extensions in this copy of the app
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f $OUT 2>/dev/null || true
pluginkit -a $OUT/Contents/PlugIns/*.appex 2>/dev/null || true
echo "built $OUT ($(du -sh $OUT | cut -f1))"

case "$1" in
  --run)  open $OUT ;;
  --test) $OUT/Contents/MacOS/stlv --test ;;
esac
