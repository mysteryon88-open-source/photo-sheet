export async function loadPhotosWithLimit(files, decoder, {
  concurrency = 3,
  onProgress = () => {},
  isCancelled = () => false,
  getPixelCount = null,
  maxPixelCount = Infinity,
  initialPixelCount = 0
} = {}) {
  const items = [...files];
  const results = Array(items.length);
  const workerCount = Math.min(items.length, Math.max(1, Math.trunc(Number(concurrency)) || 1));
  let nextIndex = 0;
  let completed = 0;
  let reservedPixelCount = Math.max(0, Number(initialPixelCount) || 0);
  let pixelBudgetExceeded = false;

  const worker = async () => {
    while (nextIndex < items.length) {
      if (isCancelled() || pixelBudgetExceeded) return;
      const index = nextIndex++;
      try {
        if (getPixelCount) {
          const pixelCount = Number(await getPixelCount(items[index]));
          if (!Number.isFinite(pixelCount) || pixelCount <= 0) throw new Error("IMAGE_DIMENSIONS_UNAVAILABLE");
          if (reservedPixelCount + pixelCount > Number(maxPixelCount)) {
            pixelBudgetExceeded = true;
            throw new Error("PHOTO_MEMORY_LIMIT");
          }
          reservedPixelCount += pixelCount;
        }
        results[index] = { status: "fulfilled", value: await decoder(items[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
      completed++;
      onProgress(completed, items.length);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, worker));
  for (let index = 0; index < results.length; index++) {
    if (!results[index]) results[index] = { status: "cancelled" };
  }
  return results;
}

export async function getImageFilePixelCount(file) {
  const header = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  let dimensions = null;

  if (matchesBytes(header, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    dimensions = [readUint32(header, 16, false), readUint32(header, 20, false)];
  } else if (matchesBytes(header, [0xff, 0xd8])) {
    dimensions = await readJpegDimensions(file);
  } else if (matchesAscii(header, 0, "RIFF") && matchesAscii(header, 8, "WEBP")) {
    dimensions = readWebpDimensions(header);
  } else if (matchesAscii(header, 0, "BM")) {
    dimensions = readBmpDimensions(header);
  }

  const [width, height] = dimensions ?? [];
  const pixelCount = Number(width) * Number(height);
  if (!Number.isSafeInteger(pixelCount) || pixelCount <= 0) throw new Error("IMAGE_DIMENSIONS_UNAVAILABLE");
  return pixelCount;
}

export function snapshotPhotosForRender(photos) {
  return photos.map(photo => ({ source: photo.source, edit: { ...photo.edit } }));
}

export function getTotalPhotoPixels(photos) {
  return photos.reduce((total, photo) => {
    const width = Number(photo.source.width || photo.source.naturalWidth) || 0;
    const height = Number(photo.source.height || photo.source.naturalHeight) || 0;
    return total + width * height;
  }, 0);
}

export async function createPhoto(file) {
  return {
    source: await loadOrientedImage(file),
    edit: { rotation: 0, flipX: false, flipY: false, cropX: 0, cropY: 0 }
  };
}

export function disposePhotos(photos) {
  for (const photo of photos) {
    if (typeof photo.source.close === "function") photo.source.close();
  }
}

export function editPhoto(photo, action) {
  if (action === "rotateLeft") photo.edit.rotation = (photo.edit.rotation + 270) % 360;
  if (action === "rotateRight") photo.edit.rotation = (photo.edit.rotation + 90) % 360;
  if (action === "flipHorizontal") photo.edit.flipX = !photo.edit.flipX;
  if (action === "flipVertical") photo.edit.flipY = !photo.edit.flipY;
}

async function loadOrientedImage(file) {
  if ("createImageBitmap" in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {}
  }

  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("IMAGE_DECODE_FAILED")); };
    image.src = url;
  });
}

async function readJpegDimensions(file) {
  const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset < file.size) {
    const bytes = new Uint8Array(await file.slice(offset, offset + 16).arrayBuffer());
    if (bytes.length < 4 || bytes[0] !== 0xff) break;
    let markerIndex = 1;
    while (bytes[markerIndex] === 0xff) markerIndex++;
    const marker = bytes[markerIndex];
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += markerIndex + 1;
      continue;
    }
    const segmentLength = (bytes[markerIndex + 1] << 8) | bytes[markerIndex + 2];
    if (segmentLength < 2) break;
    if (sofMarkers.has(marker)) {
      return [
        (bytes[markerIndex + 6] << 8) | bytes[markerIndex + 7],
        (bytes[markerIndex + 4] << 8) | bytes[markerIndex + 5]
      ];
    }
    if (marker === 0xda) break;
    offset += markerIndex + 1 + segmentLength;
  }
  return null;
}

function readWebpDimensions(bytes) {
  const chunk = String.fromCharCode(...bytes.slice(12, 16));
  if (chunk === "VP8X" && bytes.length >= 30) {
    return [1 + readUint24(bytes, 24), 1 + readUint24(bytes, 27)];
  }
  if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    return [
      1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
      1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10)
    ];
  }
  if (chunk === "VP8 " && bytes.length >= 30 && matchesBytes(bytes, [0x9d, 0x01, 0x2a], 23)) {
    return [
      (bytes[26] | (bytes[27] << 8)) & 0x3fff,
      (bytes[28] | (bytes[29] << 8)) & 0x3fff
    ];
  }
  return null;
}

function readBmpDimensions(bytes) {
  const dibSize = readUint32(bytes, 14, true);
  if (dibSize === 12) return [readUint16(bytes, 18, true), readUint16(bytes, 20, true)];
  return [Math.abs(readInt32(bytes, 18, true)), Math.abs(readInt32(bytes, 22, true))];
}

function matchesAscii(bytes, offset, value) {
  return [...value].every((character, index) => bytes[offset + index] === character.charCodeAt(0));
}

function matchesBytes(bytes, expected, offset = 0) {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function readUint16(bytes, offset, littleEndian) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, littleEndian);
}

function readUint24(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readUint32(bytes, offset, littleEndian) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, littleEndian);
}

function readInt32(bytes, offset, littleEndian) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(offset, littleEndian);
}
