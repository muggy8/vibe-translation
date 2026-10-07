/**
 * The image registry: which plates the book carries, where they land in the bundle,
 * and the manifest the extracted images are described by.
 *
 * Part of the source.js layer (split out of the original single file).
 */

const fs = require("fs").promises;
const path = require("path");
const crypto = require("crypto");
require("../../types"); // JSDoc type definitions

/**
 * Image registry: records every image referenced (or declared in the
 * manifest) while chapters are converted, and writes the deduplicated files
 * into `<volumeDir>/images/` with a manifest.json on flush.
 */
class ImageRegistry {
  /**
   * @param {JSZip} zip - The open epub zip.
   * @param {string} volumeDir - The volume folder (images land in images/ under it).
   */
  constructor(zip, volumeDir) {
    this.zip = zip;
    this.volumeDir = volumeDir;
    this.byZipPath = new Map(); // zipPath -> { file }
    this.order = []; // zipPaths in first-appearance order
  }

  /**
   * Register an image by zip path and return its Markdown reference (relative
   * to the volume folder, where the chapter files live).
   *
   * @param {string} zipPath - The image's zip entry path.
   * @returns {string} A Markdown image reference, or "" for a bad src.
   */
  reference(zipPath) {
    if (!zipPath) return "";
    if (this.byZipPath.has(zipPath)) return `![](images/${this.byZipPath.get(zipPath).file})`;
    const orig = path.posix.basename(zipPath);
    const safe = orig.replace(/[^a-zA-Z0-9._-]/g, "_") || "image";
    const file = `img-${String(this.order.length + 1).padStart(4, "0")}-${safe}`;
    this.byZipPath.set(zipPath, { file });
    this.order.push(zipPath);
    return `![](images/${file})`;
  }

  /**
   * Write the registered images to `<volumeDir>/images/` plus manifest.json.
   *
   * @returns {Promise<Array<{file: string, epubPath: string, sha256: string, bytes: number}>|null>}
   *   The manifest entries, or null when no images were registered.
   */
  async flush() {
    if (this.order.length === 0) return null;
    const imagesDir = path.join(this.volumeDir, "images");
    await fs.mkdir(imagesDir, { recursive: true });
    const entries = [];
    for (const zipPath of this.order) {
      const entry = this.zip.file(zipPath);
      if (!entry) {
        console.warn(`[source] image entry "${zipPath}" not found in the epub; skipping.`);
        continue;
      }
      const buf = await entry.async("nodebuffer");
      const sha = crypto.createHash("sha256").update(buf).digest("hex");
      const file = this.byZipPath.get(zipPath).file;
      await fs.writeFile(path.join(imagesDir, file), buf);
      entries.push({ file, epubPath: zipPath, sha256: sha, bytes: buf.length });
    }
    const manifest = { generatedAt: new Date().toISOString(), images: entries };
    await fs.writeFile(
      path.join(imagesDir, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      "utf-8"
    );
    return entries;
  }
}


module.exports = {
  ImageRegistry,
};
