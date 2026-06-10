// Uploaded-image storage for llmTerminal. Extracted from server.js (refactor 2026-06-10, phase 8).
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("./paths");

const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

function saveUploadedImage(base64Data, mimeType) {
  const ext = (mimeType || "image/png").includes("jpeg") || (mimeType || "").includes("jpg") ? ".jpg" : ".png";
  const name = "img_" + Date.now() + "_" + crypto.randomBytes(4).toString("hex") + ext;
  const filePath = path.join(UPLOADS_DIR, name);
  fs.writeFileSync(filePath, Buffer.from(base64Data, "base64"));
  return filePath;
}

module.exports = { saveUploadedImage };
