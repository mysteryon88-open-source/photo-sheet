import test from "node:test";
import assert from "node:assert/strict";

import * as layout from "../src/layout.js";
import * as photoUtils from "../src/photos.js";
import { buildPdf } from "../src/pdf.js";
import * as dpiMetadata from "../src/png-dpi.js";
import * as exportUtils from "../src/export.js";
import { translate } from "../src/i18n.js";
import { renderSheet } from "../src/renderer.js";

const { buildSheetPlan, getCutMarkSegments, resolvePaper } = layout;
const { setPngDpi } = dpiMetadata;

test("instant photo presets keep card size, image size and frames in previews and exports", () => {
  for (const [gridMode, width, height, imageWidth, imageHeight, inset] of [
    ["mini", 54, 86, 54, 86, 0],
    ["wide", 108, 86, 108, 86, 0],
    ["miniFrame", 54, 86, 46, 62, 4],
    ["wideFrame", 108, 86, 99, 62, 4.5]
  ]) {
    const plan = buildSheetPlan({ paper: { widthMm: 297, heightMm: 210 }, dpi: 254,
      marginMm: 5, gapMm: 2, gridMode, photoCount: 1 });
    assert.equal(plan.photoFit, "cover");
    assert.equal(plan.cells[0].width, width * 10);
    assert.equal(plan.cells[0].height, height * 10);
    assert.deepEqual(plan.photoFrameMm, { left: inset, top: inset, width: imageWidth, height: imageHeight });
    for (const renderedPlan of [plan, layout.fitSheetPlanToPixels(plan, 100_000)]) {
      const rects = [];
      const context = { fillRect() {}, save() {}, restore() {}, beginPath() {}, clip() {},
        rect(...args) { rects.push(args); }, translate() {}, rotate() {}, scale() {}, drawImage() {} };
      renderSheet({ getContext: () => context }, [{ source: { width: 400, height: 300 },
        edit: { rotation: 90, flipX: true, flipY: false } }], renderedPlan, false);
      const cell = renderedPlan.cells[0];
      const scale = renderedPlan.scale;
      assert.deepEqual(rects[0], [cell.x + inset * scale, cell.y + inset * scale, imageWidth * scale, imageHeight * scale]);
      assert.equal(getCutMarkSegments([cell], 1)[2][0], cell.x + width * scale);
    }
  }
});

test("large sheets require an explicit render override", () => {
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ fillStyle: "", fillRect() {} })
  };
  const plan = { widthPx: 8_001, heightPx: 8_000, cells: [] };

  assert.throws(() => renderSheet(canvas, [], plan, false), error => error.message === "TOO_LARGE");
  renderSheet(canvas, [], plan, false, Infinity);
  assert.deepEqual([canvas.width, canvas.height], [8_001, 8_000]);
});

test("resolvePaper applies orientation to predefined paper and rejects custom sizes", () => {
  assert.deepEqual(resolvePaper("10x15", "portrait"), { widthMm: 100, heightMm: 150 });
  assert.deepEqual(resolvePaper("a4", "landscape"), { widthMm: 297, heightMm: 210 });
  assert.throws(() => resolvePaper("custom", "portrait"), error => error.message === "INVALID_PAPER");
});

test("photo lookup returns the clicked cell and ignores gaps", () => {
  const cells = [
    { x: 10, y: 20, width: 30, height: 40, photoIndex: 2 },
    { x: 50, y: 20, width: 30, height: 40, photoIndex: 0 }
  ];

  assert.equal(layout.getPhotoIndexAtPoint?.(cells, 15, 25), 2);
  assert.equal(layout.getPhotoIndexAtPoint?.(cells, 45, 25), -1);
  assert.equal(layout.getPhotoIndexAtPoint?.(cells, 80, 60), 0);
});

test("viewport point maps to a photo in the scaled canvas content box", () => {
  const cells = [
    { x: 0, y: 0, width: 100, height: 100, photoIndex: 0 },
    { x: 200, y: 200, width: 100, height: 100, photoIndex: 1 }
  ];
  const viewport = { left: 100, top: 200 };
  const canvas = {
    clientLeft: 10,
    clientTop: 10,
    clientWidth: 300,
    clientHeight: 400,
    width: 600,
    height: 800
  };

  assert.equal(layout.getPhotoIndexFromViewportPoint?.(cells, viewport, canvas, { x: 235, y: 335 }), 1);
  assert.equal(layout.getPhotoIndexFromViewportPoint?.(cells, viewport, canvas, { x: 100, y: 200 }), -1);
});

test("custom grid repeats one photo across every cell", () => {
  const plan = buildSheetPlan({
    paper: { widthMm: 150, heightMm: 100 },
    dpi: 300,
    marginMm: 5,
    gapMm: 2,
    gridMode: "custom",
    columns: 3,
    rows: 2,
    photoCount: 1
  });

  assert.equal(plan.cells.length, 6);
  assert.deepEqual(plan.cells.map(cell => cell.photoIndex), [0, 0, 0, 0, 0, 0]);
});

test("custom grid preserves photo order and leaves unused slots empty", () => {
  const plan = buildSheetPlan({
    paper: { widthMm: 150, heightMm: 100 },
    dpi: 300,
    marginMm: 4,
    gapMm: 2,
    gridMode: "custom",
    columns: 3,
    rows: 2,
    photoCount: 4
  });

  assert.deepEqual(plan.cells.map(cell => cell.photoIndex), [0, 1, 2, 3]);
});

test("custom grid rejects fewer slots than selected photos", () => {
  assert.throws(() => buildSheetPlan({
    paper: { widthMm: 100, heightMm: 150 },
    dpi: 300,
    marginMm: 2,
    gapMm: 2,
    gridMode: "custom",
    columns: 2,
    rows: 2,
    photoCount: 5
  }), error => error.message === "GRID_TOO_SMALL");
});

test("automatic layout fits twelve photos in either paper orientation", () => {
  const createPlan = paper => buildSheetPlan({
    paper,
    dpi: 300,
    marginMm: 5,
    gapMm: 2,
    gridMode: "auto",
    columns: 1,
    rows: 1,
    photoCount: 12
  });

  const landscape = createPlan({ widthMm: 150, heightMm: 100 });
  const portrait = createPlan({ widthMm: 100, heightMm: 150 });

  assert.deepEqual([landscape.columns, landscape.rows, landscape.cells.length], [4, 3, 12]);
  assert.deepEqual([portrait.columns, portrait.rows, portrait.cells.length], [3, 4, 12]);
});

test("photo-size layout fits and centers exact 35 by 45 mm cells on A4", () => {
  const plan = buildSheetPlan({
    paper: { widthMm: 210, heightMm: 297 },
    dpi: 300,
    marginMm: 5,
    gapMm: 2,
    gridMode: "fixed",
    columns: 1,
    rows: 1,
    photoWidthMm: 35,
    photoHeightMm: 45,
    photoCount: 1
  });

  const firstCellMm = [plan.cells[0].x, plan.cells[0].y, plan.cells[0].width, plan.cells[0].height]
    .map(value => Math.round(value / plan.scale * 1000) / 1000);
  const lastCell = plan.cells.at(-1);
  const lastCellMm = [lastCell.x, lastCell.y].map(value => Math.round(value / plan.scale * 1000) / 1000);

  assert.deepEqual([plan.columns, plan.rows, plan.cells.length], [5, 6, 30]);
  assert.deepEqual(firstCellMm, [13.5, 8.5, 35, 45]);
  assert.deepEqual(lastCellMm, [161.5, 243.5]);
  assert.deepEqual(new Set(plan.cells.map(cell => cell.photoIndex)), new Set([0]));
});

test("photo-size layout preserves the selected fill mode", () => {
  const plan = buildSheetPlan({
    paper: { widthMm: 100, heightMm: 150 },
    dpi: 300,
    marginMm: 5,
    gapMm: 2,
    gridMode: "fixed",
    columns: 1,
    rows: 1,
    photoWidthMm: 35,
    photoHeightMm: 45,
    photoFit: "cover",
    photoCount: 1
  });

  assert.equal(plan.photoFit, "cover");
});

test("photo-size layout rejects more distinct photos than the sheet capacity", () => {
  const fullPlan = buildSheetPlan({
    paper: { widthMm: 210, heightMm: 297 },
    dpi: 300,
    marginMm: 5,
    gapMm: 2,
    gridMode: "fixed",
    columns: 1,
    rows: 1,
    photoWidthMm: 35,
    photoHeightMm: 45,
    photoCount: 30
  });

  assert.equal(fullPlan.cells.length, 30);
  assert.throws(() => buildSheetPlan({
    paper: { widthMm: 210, heightMm: 297 },
    dpi: 300,
    marginMm: 5,
    gapMm: 2,
    gridMode: "fixed",
    columns: 1,
    rows: 1,
    photoWidthMm: 35,
    photoHeightMm: 45,
    photoCount: 31
  }), error => error.message === "GRID_TOO_SMALL" && error.capacity === 30 && error.selected === 31);
});

test("photo-size layout can keep a capacity-limited preview when photos overflow", () => {
  const plan = buildSheetPlan({
    paper: { widthMm: 210, heightMm: 297 },
    dpi: 300,
    marginMm: 5,
    gapMm: 2,
    gridMode: "fixed",
    columns: 1,
    rows: 1,
    photoWidthMm: 35,
    photoHeightMm: 45,
    photoCount: 31,
    allowOverflow: true
  });

  assert.deepEqual([plan.columns, plan.rows, plan.cells.length, plan.overflowCount], [5, 6, 30, 1]);
  assert.deepEqual(plan.cells.map(cell => cell.photoIndex), Array.from({ length: 30 }, (_, index) => index));
});

test("photo-size layout keeps an exact decimal-boundary column", () => {
  const plan = buildSheetPlan({
    paper: { widthMm: 90, heightMm: 130 },
    dpi: 300,
    marginMm: 1,
    gapMm: 0.5,
    gridMode: "fixed",
    columns: 1,
    rows: 1,
    photoWidthMm: 5.4,
    photoHeightMm: 10,
    photoCount: 1
  });

  assert.equal(plan.columns, 15);
});

test("photo-size layout rejects impractically tiny cells", () => {
  assert.throws(() => buildSheetPlan({
    paper: { widthMm: 210, heightMm: 297 },
    dpi: 300,
    marginMm: 0,
    gapMm: 0,
    gridMode: "fixed",
    columns: 1,
    rows: 1,
    photoWidthMm: 4.9,
    photoHeightMm: 5,
    photoCount: 1
  }), error => error.message === "INVALID_PHOTO_SIZE");
});

test("automatic layout grows beyond twelve selected photos", () => {
  const plan = buildSheetPlan({
    paper: { widthMm: 210, heightMm: 297 },
    dpi: 300,
    marginMm: 5,
    gapMm: 2,
    gridMode: "auto",
    columns: 1,
    rows: 1,
    photoCount: 20
  });

  assert.deepEqual([plan.columns, plan.rows, plan.cells.length], [4, 5, 20]);
});

test("preview plans stay within their pixel budget without mutating the export plan", () => {
  const plan = {
    widthPx: 9_921,
    heightPx: 14_031,
    paperWidthMm: 210,
    paperHeightMm: 297,
    dpi: 1_200,
    scale: 1_200 / 25.4,
    marginMm: 5,
    gapMm: 2,
    cells: [{ x: 240, y: 360, width: 1_200, height: 1_800 }]
  };
  const original = structuredClone(plan);
  const expectedScale = Math.sqrt(8_000_000 / (9_921 * 14_031));

  const preview = layout.fitSheetPlanToPixels?.(plan, 8_000_000);

  assert.ok(preview, "fitSheetPlanToPixels must be exported");
  assert.ok(preview.widthPx * preview.heightPx <= 8_000_000);
  assert.equal(preview.paperWidthMm, 210);
  assert.equal(preview.dpi, 1_200);
  assert.ok(Math.abs(preview.cells[0].width - 1_200 * expectedScale) < 0.001);
  assert.ok(Math.abs(preview.scale - plan.scale * expectedScale) < 0.001);
  assert.deepEqual(plan, original);
});

test("A3 at 1200 DPI produces an actionable large-export error", () => {
  const details = exportUtils.getExportFailureDetails?.({
    widthPx: 19_843,
    heightPx: 14_031,
    dpi: 1_200
  });

  assert.ok(details, "getExportFailureDetails must be exported");
  assert.deepEqual(details, {
    key: "outputTooLarge",
    values: {
      width: 19_843,
      height: 14_031,
      memoryGb: "1.1",
      recommendedDpi: 600
    }
  });
});

test("large-export guidance stays accurate for every output format", () => {
  const message = translate("en", "outputTooLargeDetail", {
    width: 19_843,
    height: 14_031,
    memoryGb: "1.1",
    recommendedDpi: 600
  });

  assert.doesNotMatch(message, /PNG|JPG|PDF/);
  assert.match(message, /before encoding the file/);
});

test("single-canvas export rejects A3 at 1200 DPI but still allows A4", () => {
  const canAttempt = exportUtils.canAttemptFullResolutionExport;

  assert.ok(canAttempt, "canAttemptFullResolutionExport must be exported");
  assert.equal(canAttempt({ widthPx: 19_843, heightPx: 14_031 }), false);
  assert.equal(canAttempt({ widthPx: 14_031, heightPx: 9_921 }), true);
});

test("cut marks create two outward segments at every cell corner", () => {
  const segments = getCutMarkSegments([{ x: 10, y: 20, width: 30, height: 40 }], 3);

  assert.equal(segments.length, 8);
  assert.deepEqual(segments[0], [7, 20, 10, 20]);
  assert.deepEqual(segments[7], [40, 60, 40, 63]);
});

test("photo decoding limits concurrency while preserving order and progress", async () => {
  let active = 0;
  let peak = 0;
  const progress = [];
  const files = Array.from({ length: 9 }, (_, index) => ({ index }));

  const results = await photoUtils.loadPhotosWithLimit?.(
    files,
    async file => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active--;
      return `photo-${file.index}`;
    },
    { concurrency: 3, onProgress: (completed, total) => progress.push([completed, total]) }
  );

  assert.ok(results, "loadPhotosWithLimit must be exported");
  assert.equal(peak, 3);
  assert.deepEqual(results, files.map(file => ({ status: "fulfilled", value: `photo-${file.index}` })));
  assert.deepEqual(progress, Array.from({ length: 9 }, (_, index) => [index + 1, 9]));
});

test("photo decoding stops scheduling work after cancellation", async () => {
  let started = 0;
  let cancelled = false;

  const results = await photoUtils.loadPhotosWithLimit?.(
    Array.from({ length: 8 }, (_, index) => index),
    async value => {
      started++;
      if (value === 0) cancelled = true;
      return value;
    },
    { concurrency: 2, isCancelled: () => cancelled }
  );

  assert.ok(results, "loadPhotosWithLimit must be exported");
  assert.ok(started <= 2);
  assert.equal(results.length, 8);
  assert.ok(results.slice(started).every(result => result.status === "cancelled"));
});

test("photo loading rejects an over-budget file before decoding it", async () => {
  let decoded = 0;
  const results = await photoUtils.loadPhotosWithLimit?.(
    [{ pixels: 241_000_000 }],
    async file => {
      decoded++;
      return file;
    },
    {
      getPixelCount: file => file.pixels,
      maxPixelCount: 240_000_000
    }
  );

  assert.ok(results, "loadPhotosWithLimit must be exported");
  assert.equal(decoded, 0);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[0].reason?.message, "PHOTO_MEMORY_LIMIT");
});

test("photo pixel count is read from supported file headers without decoding", async () => {
  const png = Uint8Array.from(Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
  ));
  const jpeg = Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x03, 0x00, 0x04,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xd9
  ]);
  const webp = new Uint8Array(30);
  webp.set(new TextEncoder().encode("RIFF"), 0);
  webp.set(new TextEncoder().encode("WEBPVP8X"), 8);
  webp.set([0x03, 0x00, 0x00, 0x02, 0x00, 0x00], 24);
  const bmp = new Uint8Array(26);
  bmp.set(new TextEncoder().encode("BM"), 0);
  new DataView(bmp.buffer).setUint32(14, 40, true);
  new DataView(bmp.buffer).setInt32(18, 4, true);
  new DataView(bmp.buffer).setInt32(22, 3, true);

  assert.equal(await photoUtils.getImageFilePixelCount?.(new Blob([png], { type: "image/png" })), 1);
  assert.equal(await photoUtils.getImageFilePixelCount?.(new Blob([jpeg], { type: "image/jpeg" })), 12);
  assert.equal(await photoUtils.getImageFilePixelCount?.(new Blob([webp], { type: "image/webp" })), 12);
  assert.equal(await photoUtils.getImageFilePixelCount?.(new Blob([bmp], { type: "image/bmp" })), 12);
});

test("photo render snapshots isolate later edit changes", () => {
  const source = { id: "bitmap" };
  const photos = [{ source, edit: { rotation: 0, flipX: false, flipY: false, cropX: -0.5, cropY: 0.75 } }];

  const snapshot = photoUtils.snapshotPhotosForRender?.(photos);
  photos[0].edit.rotation = 90;
  photos[0].edit.cropX = 1;

  assert.ok(snapshot, "snapshotPhotosForRender must be exported");
  assert.equal(snapshot[0].source, source);
  assert.deepEqual(snapshot[0].edit, { rotation: 0, flipX: false, flipY: false, cropX: -0.5, cropY: 0.75 });
});

test("crop shifts stay in screen axes, clamp at image edges, and preserve framed preview geometry", () => {
  const basePlan = buildSheetPlan({ paper: { widthMm: 210, heightMm: 297 }, dpi: 254,
    marginMm: 5, gapMm: 2, gridMode: "miniFrame", photoCount: 1 });
  for (const plan of [basePlan, layout.fitSheetPlanToPixels(basePlan, 100_000)]) {
    for (const rotation of [0, 90, 180, 270]) {
      for (const [input, expected] of [[-2, -1], [-0.5, -0.5], [0, 0], [1, 1], [2, 1], [undefined, 0], [NaN, 0], [Infinity, 0]]) {
        const calls = {};
        const context = { fillRect() {}, save() {}, restore() {}, beginPath() {}, clip() {},
          rect(...args) { calls.rect = args; }, translate(...args) { calls.center = args; },
          rotate() {}, scale() {}, drawImage(...args) { calls.draw = args; } };
        const photo = { source: { width: 400, height: 100 },
          edit: { rotation, flipX: true, flipY: true, cropX: input, cropY: input } };
        for (const photoFit of ["cover", "contain"]) {
          renderSheet({ getContext: () => context }, [photo], { ...plan, photoFit }, false);
          const cell = plan.cells.at(-1);
          const width = 46 * plan.scale;
          const height = 62 * plan.scale;
          const centerX = cell.x + (4 + 23) * plan.scale;
          const centerY = cell.y + (4 + 31) * plan.scale;
          const rotated = rotation % 180 !== 0;
          const factor = (photoFit === "cover" ? Math.max : Math.min)(width / (rotated ? 100 : 400), height / (rotated ? 400 : 100));
          const extraX = photoFit === "cover" ? Math.max(0, (rotated ? 100 : 400) * factor - width) / 2 : 0;
          const extraY = photoFit === "cover" ? Math.max(0, (rotated ? 400 : 100) * factor - height) / 2 : 0;
          assert.ok(Math.abs(calls.center[0] - centerX - expected * extraX) < 1e-8);
          assert.ok(Math.abs(calls.center[1] - centerY - expected * extraY) < 1e-8);
          if (photoFit === "cover") {
            const renderedWidth = calls.draw[rotated ? 4 : 3];
            const renderedHeight = calls.draw[rotated ? 3 : 4];
            assert.ok(calls.center[0] - renderedWidth / 2 <= calls.rect[0] + 1e-8);
            assert.ok(calls.center[0] + renderedWidth / 2 >= calls.rect[0] + width - 1e-8);
            assert.ok(calls.center[1] - renderedHeight / 2 <= calls.rect[1] + 1e-8);
            assert.ok(calls.center[1] + renderedHeight / 2 >= calls.rect[1] + height - 1e-8);
          }
        }
      }
    }
  }
});

test("decoded photo pixel totals use oriented source dimensions", () => {
  assert.equal(photoUtils.getTotalPhotoPixels?.([
    { source: { width: 4_000, height: 3_000 } },
    { source: { naturalWidth: 2_000, naturalHeight: 1_500 } }
  ]), 15_000_000);
});

test("cover placement fills and clips a mismatched photo cell", () => {
  const calls = [];
  const context = {
    fillStyle: "",
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "low",
    fillRect() {},
    save() {},
    restore() {},
    beginPath() { calls.push(["beginPath"]); },
    rect(...args) { calls.push(["rect", ...args]); },
    clip() { calls.push(["clip"]); },
    translate() {},
    rotate() {},
    scale() {},
    drawImage(...args) { calls.push(["drawImage", ...args]); }
  };
  const canvas = { width: 0, height: 0, getContext: () => context };
  const photo = { source: { width: 40, height: 30 }, edit: { rotation: 0, flipX: false, flipY: false } };
  const plan = {
    widthPx: 100,
    heightPx: 100,
    photoFit: "cover",
    cells: [{ x: 10, y: 20, width: 35, height: 45, photoIndex: 0 }]
  };

  renderSheet(canvas, [photo], plan, false);

  assert.deepEqual(calls.slice(0, 3), [["beginPath"], ["rect", 10, 20, 35, 45], ["clip"]]);
  assert.deepEqual(calls.at(-1).slice(2), [-30, -22.5, 60, 45]);
});

test("buildPdf creates a one-page PDF whose xref offset is valid", () => {
  const bytes = buildPdf(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), 1200, 1800, 100, 150);
  const text = new TextDecoder("latin1").decode(bytes);
  const startXref = Number(text.match(/startxref\n(\d+)\n%%EOF/)[1]);

  assert.equal(text.slice(0, 8), "%PDF-1.4");
  assert.match(text, /\/MediaBox \[0 0 283\.465 425\.197\]/);
  assert.match(text, /\/Subtype \/Image/);
  assert.equal(text.slice(startXref, startXref + 4), "xref");
});

test("setPngDpi inserts a 300 DPI pHYs chunk after IHDR", () => {
  const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  const result = setPngDpi(png, 300);
  const type = new TextDecoder().decode(result.slice(37, 41));
  const ppm = new DataView(result.buffer, result.byteOffset + 41, 4).getUint32(0);

  assert.equal(type, "pHYs");
  assert.equal(ppm, 11811);
});

test("setJpegDpi writes 300 DPI into JFIF density fields", () => {
  const jpeg = Uint8Array.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01,
    0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xd9
  ]);

  const result = dpiMetadata.setJpegDpi?.(jpeg, 300);

  assert.ok(result, "setJpegDpi must be exported");
  assert.equal(result[13], 1);
  assert.deepEqual([...result.slice(14, 18)], [0x01, 0x2c, 0x01, 0x2c]);
  assert.equal(jpeg[13], 0);
});
