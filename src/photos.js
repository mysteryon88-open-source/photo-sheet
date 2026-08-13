export function getPhotoSelectionError(selectedCount, acceptedCount) {
  if (acceptedCount < 1 || acceptedCount !== selectedCount) return "needPhotos";
  return null;
}

export async function loadPhotosWithLimit(files, decoder, {
  concurrency = 3,
  onProgress = () => {},
  isCancelled = () => false
} = {}) {
  const items = [...files];
  const results = Array(items.length);
  const workerCount = Math.min(items.length, Math.max(1, Math.trunc(Number(concurrency)) || 1));
  let nextIndex = 0;
  let completed = 0;

  const worker = async () => {
    while (nextIndex < items.length) {
      if (isCancelled()) return;
      const index = nextIndex++;
      try {
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

export function splitItemsAtLimit(items, limit) {
  const splitIndex = Math.max(0, Math.trunc(Number(limit)) || 0);
  return { kept: items.slice(0, splitIndex), removed: items.slice(splitIndex) };
}

export function moveItem(items, fromIndex, toIndex) {
  const copy = [...items];
  if (fromIndex === toIndex || fromIndex < 0 || fromIndex >= copy.length || toIndex < 0 || toIndex >= copy.length) return copy;
  const [item] = copy.splice(fromIndex, 1);
  copy.splice(toIndex, 0, item);
  return copy;
}

export function removeItem(items, index) {
  const copy = [...items];
  if (index >= 0 && index < copy.length) copy.splice(index, 1);
  return copy;
}

export async function createPhoto(file) {
  return {
    source: await loadOrientedImage(file),
    edit: { rotation: 0, flipX: false, flipY: false }
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
