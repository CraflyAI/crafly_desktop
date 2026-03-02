const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

async function main() {
  const platform = process.platform;
  if (platform !== 'darwin' && platform !== 'win32') {
    console.log(`[ffmpeg-sync] Skip unsupported platform: ${platform}`);
    return;
  }

  let installer;
  try {
    installer = require('@ffmpeg-installer/ffmpeg');
  } catch (error) {
    console.warn('[ffmpeg-sync] @ffmpeg-installer/ffmpeg not installed yet');
    return;
  }

  const srcPath = installer.path;
  if (!srcPath || !fs.existsSync(srcPath)) {
    throw new Error(`Installer ffmpeg path not found: ${srcPath || '(empty)'}`);
  }

  const destDir = path.join(process.cwd(), 'bin', platform);
  const exeName = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const destPath = path.join(destDir, exeName);

  await fsp.mkdir(destDir, { recursive: true });
  await fsp.copyFile(srcPath, destPath);

  if (platform !== 'win32') {
    await fsp.chmod(destPath, 0o755);
  }

  console.log(`[ffmpeg-sync] Copied ${srcPath} -> ${destPath}`);
}

main().catch((error) => {
  console.error('[ffmpeg-sync] Failed:', error?.message || error);
  process.exit(1);
});
