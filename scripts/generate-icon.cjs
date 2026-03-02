/**
 * icon.svg → icon.png (512x512) for Electron app icon.
 * Run: npm run generate-icon
 * Requires: npm install sharp --save-dev
 */
const fs = require("fs");
const path = require("path");

const assetsDir = path.join(__dirname, "..", "assets");
const svgPath = path.join(assetsDir, "icon.svg");
const pngPath = path.join(assetsDir, "icon.png");

async function main() {
  let sharp;
  try {
    sharp = require("sharp");
  } catch {
    console.warn("sharp not installed. Run: npm install sharp --save-dev");
    console.warn("Or export icon.svg to 512x512 PNG manually as assets/icon.png");
    process.exit(1);
  }

  const svg = fs.readFileSync(svgPath);
  await sharp(svg)
    .resize(512, 512)
    .png()
    .toFile(pngPath);
  console.log("Written", pngPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
