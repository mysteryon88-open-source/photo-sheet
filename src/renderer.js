import { getCutMarkSegments } from "./layout.js";

const MAX_PIXELS = 64_000_000;

export function renderSheet(canvas, photos, plan, drawCutMarks, maxPixels = MAX_PIXELS) {
  if (plan.widthPx * plan.heightPx > maxPixels) throw new Error("TOO_LARGE");

  const context = canvas.getContext("2d", { alpha: false, colorSpace: "srgb" });
  canvas.width = plan.widthPx;
  canvas.height = plan.heightPx;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);

  for (const cell of plan.cells) {
    const imageCell = getPhotoImageCell(cell, plan);
    drawPhoto(context, photos[cell.photoIndex], imageCell, plan.photoFit);
  }
  if (drawCutMarks) drawMarks(context, plan);
}

export function getPhotoImageCell(cell, plan) {
  const frame = plan.photoFrameMm;
  return frame ? {
    x: cell.x + frame.left * plan.scale,
    y: cell.y + frame.top * plan.scale,
    width: frame.width * plan.scale,
    height: frame.height * plan.scale
  } : cell;
}

export function getPhotoGeometry(photo, cell, photoFit) {
  const image = photo.source;
  const sourceWidth = image.width || image.naturalWidth;
  const sourceHeight = image.height || image.naturalHeight;
  const rotated = photo.edit.rotation % 180 !== 0;
  const fittedWidth = rotated ? sourceHeight : sourceWidth;
  const fittedHeight = rotated ? sourceWidth : sourceHeight;
  const scale = (photoFit === "cover" ? Math.max : Math.min)(cell.width / fittedWidth, cell.height / fittedHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  const cropX = Number.isFinite(photo.edit.cropX) ? Math.max(-1, Math.min(1, photo.edit.cropX)) : 0;
  const cropY = Number.isFinite(photo.edit.cropY) ? Math.max(-1, Math.min(1, photo.edit.cropY)) : 0;
  const overflowX = photoFit === "cover" ? Math.max(0, (rotated ? drawHeight : drawWidth) - cell.width) : 0;
  const overflowY = photoFit === "cover" ? Math.max(0, (rotated ? drawWidth : drawHeight) - cell.height) : 0;
  return { drawWidth, drawHeight, overflowX, overflowY,
    centerX: cell.x + cell.width / 2 + cropX * overflowX / 2,
    centerY: cell.y + cell.height / 2 + cropY * overflowY / 2 };
}

export function renderCropPreview(canvas, photo, cell, width, height) {
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context.save();
  context.filter = "blur(4px)";
  context.globalAlpha = 0.65;
  drawPhoto(context, photo, cell, "cover", false);
  context.restore();
  context.clearRect(cell.x, cell.y, cell.width, cell.height);
  context.fillStyle = "#ffffff";
  context.fillRect(cell.x, cell.y, cell.width, cell.height);
  drawPhoto(context, photo, cell, "cover");
  context.strokeStyle = "#ffffff";
  context.lineWidth = 3;
  context.strokeRect(cell.x, cell.y, cell.width, cell.height);
  context.strokeStyle = "#a45f44";
  context.lineWidth = 1;
  context.strokeRect(cell.x, cell.y, cell.width, cell.height);
}

function drawPhoto(context, photo, cell, photoFit, clip = true) {
  const { drawWidth, drawHeight, centerX, centerY } = getPhotoGeometry(photo, cell, photoFit);

  context.save();
  if (photoFit === "cover" && clip) {
    context.beginPath();
    context.rect(cell.x, cell.y, cell.width, cell.height);
    context.clip();
  }
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.translate(centerX, centerY);
  context.rotate(photo.edit.rotation * Math.PI / 180);
  context.scale(photo.edit.flipX ? -1 : 1, photo.edit.flipY ? -1 : 1);
  context.drawImage(photo.source, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
  context.restore();
}

function drawMarks(context, plan) {
  const marginSpaceMm = plan.marginMm > 0 ? plan.marginMm * 0.7 : 0.5;
  const gapSpaceMm = plan.gapMm > 0 ? plan.gapMm * 0.35 : marginSpaceMm;
  const length = Math.max(0.4, Math.min(3, marginSpaceMm, gapSpaceMm)) * plan.scale;
  context.save();
  context.strokeStyle = "#111111";
  context.lineWidth = Math.max(1, 0.15 * plan.scale);
  context.beginPath();
  for (const [x1, y1, x2, y2] of getCutMarkSegments(plan.cells, length)) {
    context.moveTo(x1, y1);
    context.lineTo(x2, y2);
  }
  context.stroke();
  context.restore();
}
