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
    const frame = plan.photoFrameMm;
    const imageCell = frame ? {
      x: cell.x + frame.left * plan.scale,
      y: cell.y + frame.top * plan.scale,
      width: frame.width * plan.scale,
      height: frame.height * plan.scale
    } : cell;
    drawPhoto(context, photos[cell.photoIndex], imageCell, plan.photoFit);
  }
  if (drawCutMarks) drawMarks(context, plan);
}

function drawPhoto(context, photo, cell, photoFit) {
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
  const offsetX = photoFit === "cover" ? cropX * Math.max(0, (rotated ? drawHeight : drawWidth) - cell.width) / 2 : 0;
  const offsetY = photoFit === "cover" ? cropY * Math.max(0, (rotated ? drawWidth : drawHeight) - cell.height) / 2 : 0;

  context.save();
  if (photoFit === "cover") {
    context.beginPath();
    context.rect(cell.x, cell.y, cell.width, cell.height);
    context.clip();
  }
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.translate(cell.x + cell.width / 2 + offsetX, cell.y + cell.height / 2 + offsetY);
  context.rotate(photo.edit.rotation * Math.PI / 180);
  context.scale(photo.edit.flipX ? -1 : 1, photo.edit.flipY ? -1 : 1);
  context.drawImage(image, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
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
