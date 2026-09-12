// Uploaded-image storage for llmTerminal. Extracted from server.js (refactor 2026-06-10, phase 8).
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { DATA_DIR } = require("./paths");

const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// HEIC container: bytes 4-8 = "ftyp", bytes 8-16 include one of the HEIC brands.
// Chrome pastes HEIC (AirDropped from iPhone) with type=image/heic that <img> can't
// render — normalize on the server so previews work + Read/agent tools get a JPEG.
function _isHeicBuffer(buf) {
  if (!buf || buf.length < 16) return false;
  if (buf.slice(4, 8).toString("ascii") !== "ftyp") return false;
  const brand = buf.slice(8, 16).toString("ascii");
  return /heic|heix|hevc|hevx|mif1|msf1|heim|heis|hevm|hevs/.test(brand);
}

function _convertHeicToJpeg(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    execFile("convert", [inputPath, outputPath], { timeout: 20000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error("HEIC convert failed: " + (stderr || err.message)));
      resolve();
    });
  });
}

async function saveUploadedImage(base64Data, mimeType) {
  const buf = Buffer.from(base64Data, "base64");
  const isHeicMime = /image\/(heic|heif)/i.test(mimeType || "");
  const isHeic = isHeicMime || _isHeicBuffer(buf);
  const isJpeg = /image\/(jpe?g)/i.test(mimeType || "") || (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff);
  const ext = (isHeic || isJpeg) ? ".jpg" : ".png";
  const name = "img_" + Date.now() + "_" + crypto.randomBytes(4).toString("hex") + ext;
  const filePath = path.join(UPLOADS_DIR, name);
  if (isHeic) {
    const heicPath = filePath + ".heic";
    fs.writeFileSync(heicPath, buf);
    try {
      await _convertHeicToJpeg(heicPath, filePath);
    } finally {
      try { fs.unlinkSync(heicPath); } catch {}
    }
  } else {
    fs.writeFileSync(filePath, buf);
  }
  return filePath;
}

module.exports = { saveUploadedImage };
