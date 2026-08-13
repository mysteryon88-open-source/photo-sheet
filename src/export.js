import { buildPdf } from "./pdf.js";
import { setJpegDpi, setPngDpi } from "./png-dpi.js";

const LARGE_OUTPUT_PIXELS = 64_000_000;
const MAX_SINGLE_CANVAS_PIXELS = 240_000_000;

export function canAttemptFullResolutionExport(plan) {
  return Number(plan.widthPx) * Number(plan.heightPx) <= MAX_SINGLE_CANVAS_PIXELS;
}

export function getExportFailureDetails(plan) {
  const width = Number(plan.widthPx);
  const height = Number(plan.heightPx);
  const pixelCount = width * height;
  if (pixelCount > LARGE_OUTPUT_PIXELS) {
    return {
      key: "outputTooLarge",
      values: {
        width,
        height,
        memoryGb: (pixelCount * 4 / 1_000_000_000).toFixed(1),
        recommendedDpi: Number(plan.dpi) > 600 ? 600 : Number(plan.dpi) > 300 ? 300 : 150
      }
    };
  }
  return { key: "exportFailed", values: { width, height } };
}

export async function canvasToPng(canvas, dpi) {
  const png = await canvasBlob(canvas, "image/png");
  return new Blob([setPngDpi(new Uint8Array(await png.arrayBuffer()), dpi)], { type: "image/png" });
}

export async function canvasToJpeg(canvas, dpi) {
  const jpeg = await canvasBlob(canvas, "image/jpeg", 0.95);
  return new Blob([setJpegDpi(new Uint8Array(await jpeg.arrayBuffer()), dpi)], { type: "image/jpeg" });
}

export async function canvasToPdfBlob(canvas, plan) {
  const jpeg = await canvasBlob(canvas, "image/jpeg", 1);
  const pdf = buildPdf(new Uint8Array(await jpeg.arrayBuffer()), canvas.width, canvas.height, plan.paperWidthMm, plan.paperHeightMm);
  return new Blob([pdf], { type: "application/pdf" });
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function createPrintController(image, pageStyle) {
  let currentUrl = null;
  const cleanup = () => {
    if (currentUrl) URL.revokeObjectURL(currentUrl);
    currentUrl = null;
    image.removeAttribute("src");
    pageStyle.textContent = "";
  };
  window.addEventListener("afterprint", cleanup);

  return {
    async print(blob, plan) {
      cleanup();
      currentUrl = URL.createObjectURL(blob);
      image.src = currentUrl;
      await image.decode();
      document.documentElement.style.setProperty("--print-width", `${plan.paperWidthMm}mm`);
      document.documentElement.style.setProperty("--print-height", `${plan.paperHeightMm}mm`);
      pageStyle.textContent = `@page { size: ${plan.paperWidthMm}mm ${plan.paperHeightMm}mm; margin: 0; }`;
      window.print();
    },
    cleanup
  };
}

function canvasBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("CANVAS_EXPORT_FAILED")), type, quality));
}
