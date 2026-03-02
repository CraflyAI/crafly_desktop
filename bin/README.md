# Bundled FFmpeg Layout

Place FFmpeg binaries here during packaging/build steps:

- `bin/darwin/ffmpeg`
- `bin/win32/ffmpeg.exe`

The desktop app currently checks bundled FFmpeg first (no user-installed ffmpeg fallback).
