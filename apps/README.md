# Android and macOS apps

The apps are the Studio itself — the same build as
https://jonwenjen.github.io/Underwater-recovery/ — packaged to install and run
offline. All processing stays on the device, as on the website.

**Download:** [Releases → `app-latest`](https://github.com/jonwenjen/Underwater-recovery/releases/tag/app-latest),
rebuilt by `.github/workflows/apps.yml` on every change to the app.

| | Android | macOS |
|---|---|---|
| File | `UnderwaterRecovery-android.apk` | `UnderwaterRecovery-mac-arm64.dmg` (Apple silicon), `-x64.dmg` (Intel) |
| Shell | Capacitor 8 (Android System WebView = Chromium) | Electron 44 (Chromium) |
| Needs | Android 7.0+ (API 24) with a current WebView | macOS 12+ |
| Saving | Documents/UnderwaterRecovery (share sheet as fallback) | Save dialog, or straight to disk for video |

## Install

**Android.** Download the APK on the phone, open it, and allow installing apps
from that source when asked. Later builds install over it (same signing key,
higher version code).

**macOS.** Open the DMG and drag the app to Applications. The app is ad-hoc
signed, not notarised (that needs a paid Apple Developer ID), so the first
launch is blocked: right-click the app → **Open** → **Open**, or System
Settings → Privacy & Security → **Open Anyway**. If macOS says the app is
damaged, run `xattr -cr "/Applications/Underwater Recovery Studio.app"`.

## How it is built

- `npm run build:app` — the web build with relative paths (`APP_BUILD=1`), so
  it runs from the app's own origin instead of `/Underwater-recovery/`.
- **Android** (`apps/android`, a Capacitor project): `npm run android:sync`
  copies the build into the project, then `./gradlew assembleRelease` in
  `apps/android` (JDK 21 + Android SDK 36). Exports go through
  `src/native.ts` (Filesystem + Share plugins), because a WebView ignores
  browser downloads.
- **macOS** (`apps/mac`): the build is copied to `apps/mac/web` and served
  from a private `app://` origin (`main.cjs`), so module scripts, `fetch()` of
  the AI model and secure-context APIs (WebCodecs, WebGPU, File System Access)
  work as in Chrome. `npm ci && npm run dist` in `apps/mac` makes the DMGs.
- Icons: `apps/icon.svg` → `node apps/render-icons.mjs` (every Android density,
  the launch splash, and the macOS icon).

## Signing

`apps/android/sideload.keystore` is a key committed with the project so that
any CI build can update an installed copy. It is public, so it proves nothing
about who built an APK — fine for sideloading your own builds, not for a store.
For Google Play, create your own upload key and pass it through the
`ANDROID_KEYSTORE`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and
`ANDROID_KEY_PASSWORD` environment variables (`app/build.gradle`). The Mac App
Store and notarisation likewise need an Apple Developer ID.
