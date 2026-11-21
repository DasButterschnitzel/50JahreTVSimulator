#!/bin/sh
# Lädt die zum Bauen der App nötigen Teile des Android-SDK nach $ANDROID_HOME
# (Standard: ~/android-sdk). Wer Android Studio benutzt, braucht dieses Skript nicht.
#
# Das SDK steht unter den Lizenzbedingungen von Google
# (https://developer.android.com/studio/terms). Das Skript fragt beim ersten Lauf
# danach. Nur wer die Bedingungen gelesen und angenommen hat, kann die Nachfrage mit
#   ANDROID_SDK_LICENSE=accept sh install-sdk.sh
# überspringen.
set -e
SDK="${ANDROID_HOME:-$HOME/android-sdk}"
TOOLS_ZIP="commandlinetools-linux-11076708_latest.zip"
MANAGER="$SDK/cmdline-tools/latest/bin/sdkmanager"

if [ ! -x "$MANAGER" ]; then
  mkdir -p "$SDK/cmdline-tools"
  TMP="$(mktemp -d)"
  echo "Lade Android-Kommandozeilenwerkzeuge ..."
  curl -fsSL -o "$TMP/tools.zip" "https://dl.google.com/android/repository/$TOOLS_ZIP"
  unzip -q "$TMP/tools.zip" -d "$TMP"
  rm -rf "$SDK/cmdline-tools/latest"
  mv "$TMP/cmdline-tools" "$SDK/cmdline-tools/latest"
  rm -rf "$TMP"
fi

if [ "$ANDROID_SDK_LICENSE" = "accept" ]; then
  yes | "$MANAGER" --sdk_root="$SDK" --licenses >/dev/null
else
  "$MANAGER" --sdk_root="$SDK" --licenses
fi
"$MANAGER" --sdk_root="$SDK" "platforms;android-35" "build-tools;35.0.0"

echo
echo "Android-SDK liegt in $SDK"
echo "Zum Bauen:  export ANDROID_HOME=$SDK  &&  ./gradlew assembleDebug"
