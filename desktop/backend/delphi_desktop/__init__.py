"""The macOS app's backend: delphi-core's API, built for one person's library on disk.

The shell (`desktop/main/backend.ts`) runs `delphi_desktop.main:app` under the
bundled interpreter. Everything the app serves is core's; this package chooses
the settings class and the stores, and nothing else.
"""
