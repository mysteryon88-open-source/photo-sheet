import { canAttemptFullResolutionExport, canvasToJpeg, canvasToPdfBlob, canvasToPng, createPrintController, downloadBlob, getExportFailureDetails } from "./export.js";
import { translate } from "./i18n.js";
import { buildSheetPlan, fitSheetPlanToPixels, getPhotoIndexFromViewportPoint, resolvePaper } from "./layout.js";
import { createPhoto, disposePhotos, editPhoto, getImageFilePixelCount, getTotalPhotoPixels, loadPhotosWithLimit, snapshotPhotosForRender } from "./photos.js";
import { getPhotoGeometry, getPhotoImageCell, renderCropPreview, renderSheet } from "./renderer.js";

const RENDER_DELAY_MS = 90;
const PREVIEW_MAX_PIXELS = 8_000_000;
const PHOTO_LOAD_CONCURRENCY = 3;
const MAX_DECODED_PHOTO_PIXELS = 240_000_000;
const supportedTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/bmp", "image/x-ms-bmp"]);
const photoToolIcons = {
  cropReset: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5"/><path d="M4.5 9a8 8 0 1 1-.2 6"/></svg>',
  rotateLeft: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8V3h5"/><path d="M4.5 8A8 8 0 1 1 7 18.5"/></svg>',
  rotateRight: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 8V3h-5"/><path d="M19.5 8A8 8 0 1 0 17 18.5"/></svg>',
  flipHorizontal: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M10 5 4 12l6 7V5Zm4 0 6 7-6 7V5Z"/></svg>',
  flipVertical: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h18M5 10l7-6 7 6H5Zm0 4 7 6 7-6H5Z"/></svg>',
  removePhoto: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg>',
  addPhotos: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h10v14H4zM7 15l2-2 2 2 3-3"/><path d="M19 8v8M15 12h8"/></svg>',
  clearCanvas: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg>'
};
const byId = id => document.getElementById(id);

const elements = {
  sidebar: document.querySelector(".sidebar"),
  canvas: byId("preview"),
  reorderTarget: byId("reorderTarget"),
  selectionOutline: byId("selectionOutline"),
  emptyPreview: byId("emptyPreview"),
  previewStage: document.querySelector(".preview-stage"),
  fileInput: byId("files"),
  replacePhotos: byId("replacePhotos"),
  addPhotos: byId("addPhotos"),
  drop: byId("drop"),
  photoMenu: byId("photoMenu"),
  status: byId("status"),
  exportFormat: byId("exportFormat"),
  saveFile: byId("saveFile"),
  print: byId("print"),
  language: byId("language"),
  theme: byId("theme"),
  help: byId("help"),
  helpDialog: byId("helpDialog"),
  helpClose: byId("helpClose"),
  paper: byId("paper"),
  orientation: byId("orientation"),
  dpi: byId("dpi"),
  gridMode: byId("gridMode"),
  customGridFields: byId("customGridFields"),
  photoSizeFields: byId("photoSizeFields"),
  columns: byId("columns"),
  rows: byId("rows"),
  photoWidth: byId("photoWidth"),
  photoHeight: byId("photoHeight"),
  photoFit: byId("photoFit"),
  cropControls: byId("cropControls"),
  cropTitle: byId("cropTitle"),
  cropPreview: byId("cropPreview"),
  cropReset: byId("cropReset"),
  margin: byId("margin"),
  marginValue: byId("marginValue"),
  gap: byId("gap"),
  gapValue: byId("gapValue"),
  cutMarks: byId("cutMarks"),
  statusActions: byId("statusActions"),
  trimPhotos: byId("trimPhotos")
};

const printController = createPrintController(byId("printImage"), byId("pageStyle"));
let locale = localStorage.getItem("locale") === "en" ? "en" : "ru";
let photos = [];
let selectedPhotoIndex = 0;
let selectedCellIndex = 0;
let lastPlan = null;
let lastPreviewPlan = null;
let renderTimer = 0;
let renderVersion = 0;
let loadVersion = 0;
let fileInputMode = "replace";
let statusState = { key: null, values: {} };
let outputBusy = false;
let overflowCapacity = 0;
let cancelPhotoDrag = () => {};

elements.cropReset.innerHTML = photoToolIcons.cropReset;
bindEvents();
setTheme(localStorage.getItem("theme") === "dark" ? "dark" : "light");
setLocale(locale);
syncConditionalControls();
syncPhotoControls();

function bindEvents() {
  let backdropPressed = false;
  const outsideHelp = event => {
    const rect = elements.helpDialog.getBoundingClientRect();
    return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
  };
  elements.helpDialog.addEventListener("pointerdown", event => {
    backdropPressed = event.target === elements.helpDialog && outsideHelp(event);
  });
  elements.helpDialog.addEventListener("pointerup", event => {
    if (backdropPressed && event.target === elements.helpDialog && outsideHelp(event)) elements.helpDialog.close();
    backdropPressed = false;
  });
  elements.helpDialog.addEventListener("pointercancel", () => { backdropPressed = false; });
  elements.help.addEventListener("click", () => {
    cancelPhotoDrag();
    closePhotoMenu();
    elements.helpDialog.showModal();
  });
  elements.language.addEventListener("click", () => setLocale(locale === "ru" ? "en" : "ru"));
  elements.theme.addEventListener("click", () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !elements.photoMenu.hidden) closePhotoMenu();
  });
  bindCanvasReorder();

  elements.replacePhotos.addEventListener("click", () => openFilePicker("replace"));
  elements.addPhotos.addEventListener("click", () => openFilePicker("add"));
  elements.fileInput.addEventListener("change", () => {
    const files = [...elements.fileInput.files];
    elements.fileInput.value = "";
    if (files.length > 0) loadPhotos(files, fileInputMode);
  });
  bindFileDrop(elements.drop);
  bindFileDrop(elements.previewStage);

  for (const select of [elements.paper, elements.orientation, elements.dpi, elements.gridMode, elements.photoFit]) {
    select.addEventListener("change", () => {
      if (select === elements.gridMode && select.value === "custom") {
        elements.columns.value = String(lastPlan?.columns ?? Number(elements.columns.value));
        elements.rows.value = String(lastPlan?.rows ?? Number(elements.rows.value));
      }
      syncConditionalControls();
      syncPhotoControls();
      scheduleRender();
    });
  }
  for (const input of [elements.columns, elements.rows, elements.photoWidth, elements.photoHeight]) {
    input.addEventListener("input", scheduleRender);
  }
  elements.cutMarks.addEventListener("change", scheduleRender);
  elements.cropReset.addEventListener("click", () => {
    applySelectedPhotoAction("cropReset");
  });
  elements.trimPhotos.addEventListener("click", trimPhotosToCapacity);
  bindRange(elements.margin, elements.marginValue);
  bindRange(elements.gap, elements.gapValue);

  elements.photoMenu.addEventListener("click", event => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    event.stopPropagation();
    applySelectedPhotoAction(button.dataset.action);
    closePhotoMenu();
  });
  elements.previewStage.addEventListener("contextmenu", openPhotoMenu);
  elements.previewStage.addEventListener("keydown", event => {
    if (outputBusy) return;
    if (event.key === "Tab" && lastPreviewPlan?.cells.length) {
      const next = selectedCellIndex + (event.shiftKey ? -1 : 1);
      if (next >= 0 && next < lastPreviewPlan.cells.length) {
        event.preventDefault();
        selectedCellIndex = next;
        selectedPhotoIndex = lastPreviewPlan.cells[next].photoIndex;
        syncPhotoControls();
      }
      return;
    }
    if (event.key === "Delete" && photos[selectedPhotoIndex]) {
      event.preventDefault();
      removeSelectedPhoto();
      return;
    }
    if (event.altKey && photos.length > 0 && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault();
      movePhoto(selectedPhotoIndex, selectedPhotoIndex + (event.key === "ArrowLeft" ? -1 : 1));
      return;
    }
    if (!event.altKey && event.key.startsWith("Arrow") && photos[selectedPhotoIndex] && elements.photoFit.value === "cover") {
      event.preventDefault();
      cancelPhotoDrag();
      const axis = event.key === "ArrowLeft" || event.key === "ArrowRight" ? "cropX" : "cropY";
      const delta = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -0.05 : 0.05;
      const edit = photos[selectedPhotoIndex].edit;
      edit[axis] = Math.max(-1, Math.min(1, (edit[axis] ?? 0) + delta));
      scheduleRender({ keepPreviewPlan: true });
      return;
    }
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) openPhotoMenu(event);
  });
  document.addEventListener("pointerdown", event => {
    if (!elements.photoMenu.contains(event.target)) closePhotoMenu();
  });
  window.addEventListener("resize", () => {
    closePhotoMenu();
    hideReorderTarget();
    syncSelectionOutline();
  });
  window.addEventListener("scroll", syncSelectionOutline, true);

  elements.saveFile.addEventListener("click", saveSelectedFile);
  elements.print.addEventListener("click", printSheet);
  window.addEventListener("beforeunload", () => {
    disposePhotos(photos);
    printController.cleanup();
  });
}

function openFilePicker(mode) {
  if (outputBusy) return;
  fileInputMode = mode;
  elements.fileInput.click();
}

function bindFileDrop(target) {
  for (const eventName of ["dragenter", "dragover"]) {
    target.addEventListener(eventName, event => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      target.classList.add("drag");
    });
  }
  target.addEventListener("dragleave", event => {
    if (!target.contains(event.relatedTarget)) target.classList.remove("drag");
  });
  target.addEventListener("drop", event => {
    event.preventDefault();
    target.classList.remove("drag");
    loadPhotos([...event.dataTransfer.files], "add");
  });
}

function bindRange(slider, numberInput) {
  const apply = value => Math.min(Number(slider.max), Math.max(Number(slider.min), Number(value)));
  slider.addEventListener("input", () => {
    numberInput.value = slider.value;
    scheduleRender();
  });
  numberInput.addEventListener("input", () => {
    if (numberInput.value === "" || !Number.isFinite(Number(numberInput.value))) return;
    slider.value = String(apply(numberInput.value));
    scheduleRender();
  });
  numberInput.addEventListener("change", () => {
    const value = apply(numberInput.value || slider.value);
    slider.value = String(value);
    numberInput.value = String(value);
    scheduleRender();
  });
}

async function loadPhotos(files, mode) {
  cancelPhotoDrag();
  if (outputBusy) return;
  const version = ++loadVersion;
  const accepted = files.filter(isSupportedImage);
  if (accepted.length < 1 || accepted.length !== files.length) {
    showStatus("needPhotos");
    return;
  }

  clearTimeout(renderTimer);
  closePhotoMenu();
  renderVersion++;
  disableExports();
  showStatus("loadingProgress", { completed: 0, total: accepted.length });
  const results = await loadPhotosWithLimit(accepted, createPhoto, {
    concurrency: PHOTO_LOAD_CONCURRENCY,
    isCancelled: () => version !== loadVersion,
    getPixelCount: getImageFilePixelCount,
    maxPixelCount: MAX_DECODED_PHOTO_PIXELS,
    initialPixelCount: mode === "add" ? getTotalPhotoPixels(photos) : 0,
    onProgress: (completed, total) => {
      if (version === loadVersion) showStatus("loadingProgress", { completed, total });
    }
  });
  const loaded = results.filter(result => result.status === "fulfilled").map(result => result.value);
  if (version !== loadVersion) {
    disposePhotos(loaded);
    return;
  }
  if (results.some(result => result.status === "rejected" && result.reason?.message === "PHOTO_MEMORY_LIMIT")) {
    disposePhotos(loaded);
    if (photos.length > 0) await renderSelection();
    showStatus("photoMemoryLimit");
    return;
  }
  if (results.some(result => result.status === "rejected")) {
    disposePhotos(loaded);
    if (photos.length > 0) await renderSelection();
    showStatus("error");
    return;
  }

  const nextPhotos = mode === "add" ? [...photos, ...loaded] : loaded;
  if (mode === "replace") disposePhotos(photos);
  photos = nextPhotos;
  selectedPhotoIndex = mode === "add" ? photos.length - loaded.length : 0;
  syncConditionalControls();
  syncPhotoControls();
  await renderSelection();
}

function isSupportedImage(file) {
  return supportedTypes.has(file.type) || /\.(jpe?g|png|webp|bmp)$/i.test(file.name);
}

function syncPhotoControls() {
  cancelPhotoDrag();
  elements.addPhotos.hidden = photos.length === 0;
  elements.replacePhotos.textContent = t(photos.length === 0 ? "choosePhotos" : "replacePhotos");
  selectedPhotoIndex = Math.min(selectedPhotoIndex, Math.max(0, photos.length - 1));
  elements.sidebar.classList.toggle("has-photos", photos.length > 0);
  elements.canvas.classList.toggle("reorderable", photos.length > 1 || (photos.length > 0 && elements.photoFit.value === "cover"));
  syncSelectionOutline();
  const labelKey = photos.length > 1 ? "canvasReorderLabel" : photos.length === 1 ? "canvasPhotoLabel" : "previewLabel";
  elements.previewStage.setAttribute("aria-label", t(labelKey, {
    number: selectedPhotoIndex + 1,
    count: photos.length
  }));
  syncCropControls();
}

function syncSelectionOutline() {
  const cells = lastPreviewPlan?.cells ?? [];
  elements.selectionOutline.hidden = photos.length === 0 || elements.canvas.hidden || cells.length === 0;
  if (elements.selectionOutline.hidden) return;
  if (cells[selectedCellIndex]?.photoIndex !== selectedPhotoIndex) {
    const matching = cells.findIndex(cell => cell.photoIndex === selectedPhotoIndex);
    selectedCellIndex = matching >= 0 ? matching : Math.min(selectedCellIndex, cells.length - 1);
  }
  selectedPhotoIndex = cells[selectedCellIndex].photoIndex;
  const rect = getCellViewportRect(cells[selectedCellIndex]);
  Object.assign(elements.selectionOutline.style, {
    left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`
  });
}

function syncCropControls() {
  const photo = photos[selectedPhotoIndex];
  elements.cropControls.hidden = !photo || elements.photoFit.value !== "cover";
  if (!photo) return;
  elements.cropTitle.textContent = t("cropTitle", { number: selectedPhotoIndex + 1 });
  elements.cropReset.disabled = outputBusy;
}

function getCanvasPhotoIndex(event) {
  if (elements.canvas.hidden || !lastPreviewPlan) return -1;
  return getPhotoIndexFromViewportPoint(
    lastPreviewPlan.cells,
    elements.canvas.getBoundingClientRect(),
    elements.canvas,
    { x: event.clientX, y: event.clientY }
  );
}

function getPhotoCellViewportRect(photoIndex) {
  const cell = lastPreviewPlan?.cells.find(item => item.photoIndex === photoIndex);
  if (!cell || elements.canvas.hidden) return null;
  return getCellViewportRect(cell);
}

function getCellViewportRect(cell) {
  const bounds = elements.canvas.getBoundingClientRect();
  const scaleX = elements.canvas.clientWidth / elements.canvas.width;
  const scaleY = elements.canvas.clientHeight / elements.canvas.height;
  return {
    left: bounds.left + elements.canvas.clientLeft + cell.x * scaleX,
    top: bounds.top + elements.canvas.clientTop + cell.y * scaleY,
    width: cell.width * scaleX,
    height: cell.height * scaleY
  };
}

function showReorderTarget(photoIndex) {
  const rect = getPhotoCellViewportRect(photoIndex);
  elements.reorderTarget.hidden = !rect;
  if (!rect) return;
  Object.assign(elements.reorderTarget.style, {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`
  });
}

function hideReorderTarget() {
  elements.reorderTarget.hidden = true;
}

function bindCanvasReorder() {
  let drag = null;

  function changeZoom(photo, factor) {
    photo.edit.zoom = Math.max(1, Math.min(8, (photo.edit.zoom ?? 1) * factor));
  }

  elements.previewStage.addEventListener("keydown", event => {
    if (outputBusy || event.ctrlKey || event.metaKey || elements.photoFit.value !== "cover" || !photos[selectedPhotoIndex]) return;
    if (!["+", "=", "-"].includes(event.key)) return;
    event.preventDefault();
    cancelPhotoDrag();
    changeZoom(photos[selectedPhotoIndex], event.key === "-" ? 1 / 1.1 : 1.1);
    scheduleRender({ keepPreviewPlan: true });
  });

  window.addEventListener("wheel", event => {
    if (elements.helpDialog.open) return;
    if (outputBusy || event.ctrlKey || event.metaKey || elements.photoFit.value !== "cover" || !event.deltaY) return;
    const cell = hitCell(event);
    if (!drag && !cell) return;
    event.preventDefault();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1);
    const factor = Math.exp(Math.max(-0.4, Math.min(0.4, -delta * 0.002)));
    if (drag) {
      if (!drag.canCrop || (cell && cell.photoIndex !== drag.fromIndex)) return;
      changeZoom(drag.previewPhoto, factor);
      drag.startEdit = { ...drag.previewPhoto.edit };
      drag.startX = event.clientX;
      drag.startY = event.clientY;
      drag.geometry = getPhotoGeometry(drag.previewPhoto, drag.imageCell, "cover");
      drag.active = true;
      drag.targetCell = cell;
      hideReorderTarget();
      showCrop();
    } else {
      selectedPhotoIndex = cell.photoIndex;
      changeZoom(photos[selectedPhotoIndex], factor);
      syncPhotoControls();
      scheduleRender({ keepPreviewPlan: true });
    }
  }, { passive: false });

  function hitCell(event) {
    if (elements.canvas.hidden) return null;
    return lastPreviewPlan?.cells.find(cell => {
      const rect = getCellViewportRect(cell);
      return event.clientX >= rect.left && event.clientX <= rect.left + rect.width &&
        event.clientY >= rect.top && event.clientY <= rect.top + rect.height;
    });
  }

  cancelPhotoDrag = () => {
    const previous = drag;
    drag = null;
    elements.cropPreview.hidden = true;
    elements.canvas.classList.remove("reordering");
    hideReorderTarget();
    if (previous && elements.canvas.hasPointerCapture(previous.pointerId)) {
      elements.canvas.releasePointerCapture(previous.pointerId);
    }
    if (previous?.needsRender) scheduleRender();
  };

  function showCrop() {
    elements.cropPreview.hidden = false;
    renderCropPreview(elements.cropPreview, drag.previewPhoto, drag.imageCell, window.innerWidth, window.innerHeight);
  }

  elements.canvas.addEventListener("pointerdown", event => {
    if (drag || outputBusy || !event.isPrimary || event.button !== 0 || photos.length === 0) return;
    const cell = hitCell(event);
    if (!cell) return;
    const photoIndex = cell.photoIndex;
    selectedPhotoIndex = photoIndex;
    selectedCellIndex = lastPreviewPlan.cells.indexOf(cell);
    syncPhotoControls();
    elements.previewStage.focus({ preventScroll: true });
    const canCrop = lastPreviewPlan.photoFit === "cover";
    if (photos.length < 2 && !canCrop) return;
    const photo = photos[photoIndex];
    const rect = getCellViewportRect(getPhotoImageCell(cell, lastPreviewPlan));
    const imageCell = { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    clearTimeout(renderTimer);
    renderTimer = 0;
    renderVersion++;
    drag = {
      pointerId: event.pointerId,
      fromIndex: photoIndex,
      targetCell: cell,
      photo,
      previewPhoto: { source: photo.source, edit: { ...photo.edit } },
      startEdit: { ...photo.edit },
      imageCell,
      geometry: getPhotoGeometry(photo, imageCell, "cover"),
      canCrop,
      needsRender: !lastPlan,
      startX: event.clientX,
      startY: event.clientY,
      active: false
    };
    elements.canvas.setPointerCapture(event.pointerId);
    if (canCrop) showCrop();
    event.preventDefault();
  });

  function updateDrag(event) {
    if (drag?.pointerId !== event.pointerId) return;
    if (!drag.active && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return;
    drag.active = true;
    elements.canvas.classList.add("reordering");
    closePhotoMenu();
    drag.targetCell = hitCell(event);
    hideReorderTarget();
    elements.cropPreview.hidden = true;
    if ((!drag.targetCell || drag.targetCell.photoIndex === drag.fromIndex) && drag.canCrop) {
      for (const [axis, overflow, delta] of [
        ["cropX", drag.geometry.overflowX, event.clientX - drag.startX],
        ["cropY", drag.geometry.overflowY, event.clientY - drag.startY]
      ]) {
        drag.previewPhoto.edit[axis] = overflow > 1e-9
          ? Math.max(-1, Math.min(1, (drag.startEdit[axis] ?? 0) + delta * 2 / overflow)) : 0;
      }
      showCrop();
    } else if (drag.targetCell && drag.targetCell.photoIndex !== drag.fromIndex) {
      showReorderTarget(drag.targetCell.photoIndex);
    }
    event.preventDefault();
  }
  window.addEventListener("pointermove", updateDrag);

  window.addEventListener("pointerup", event => finishPhotoDrag(event, true));
  window.addEventListener("pointercancel", event => finishPhotoDrag(event, false));
  elements.canvas.addEventListener("lostpointercapture", event => finishPhotoDrag(event, false));
  window.addEventListener("blur", cancelPhotoDrag);
  window.addEventListener("resize", cancelPhotoDrag);
  window.addEventListener("scroll", cancelPhotoDrag, true);
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") cancelPhotoDrag();
  });

  function finishPhotoDrag(event, shouldMove) {
    if (drag?.pointerId !== event.pointerId) return;
    if (shouldMove) updateDrag(event);
    const { active, fromIndex, targetCell, photo, previewPhoto, canCrop } = drag;
    cancelPhotoDrag();
    if (!active || !shouldMove || outputBusy || photos[fromIndex] !== photo) return;
    if ((!targetCell || targetCell.photoIndex === fromIndex) && canCrop) {
      photo.edit.cropX = previewPhoto.edit.cropX;
      photo.edit.cropY = previewPhoto.edit.cropY;
      photo.edit.zoom = previewPhoto.edit.zoom;
      scheduleRender();
    } else if (targetCell && targetCell.photoIndex !== fromIndex) {
      movePhoto(fromIndex, targetCell.photoIndex);
    }
  }
}

function applySelectedPhotoAction(action) {
  if (outputBusy) return;
  cancelPhotoDrag();
  if (action === "addPhotos") return openFilePicker("add");
  if (action === "clearCanvas") return clearPhotos();
  if (action === "removePhoto") return removeSelectedPhoto();
  if (!photos[selectedPhotoIndex]) return;
  editPhoto(photos[selectedPhotoIndex], action);
  syncPhotoControls();
  scheduleRender();
}

function openPhotoMenu(event) {
  cancelPhotoDrag();
  if (outputBusy) return;
  const photoIndex = event.type === "keydown" ? (photos.length > 0 ? selectedPhotoIndex : -1) : getCanvasPhotoIndex(event);
  event.preventDefault();
  if (photoIndex >= 0) {
    selectedPhotoIndex = photoIndex;
    syncPhotoControls();
  }
  renderPhotoMenu(photoIndex);
  elements.photoMenu.hidden = false;
  const cellBounds = getPhotoCellViewportRect(photoIndex);
  const stageBounds = elements.previewStage.getBoundingClientRect();
  const hasPointerPosition = Number.isFinite(event.clientX) && event.clientX > 0;
  const left = hasPointerPosition ? event.clientX : cellBounds?.left ?? stageBounds.left + 10;
  const top = hasPointerPosition ? event.clientY : cellBounds ? cellBounds.top + cellBounds.height : stageBounds.top + 10;
  elements.photoMenu.style.left = `${Math.max(10, Math.min(left, window.innerWidth - elements.photoMenu.offsetWidth - 10))}px`;
  elements.photoMenu.style.top = `${Math.max(10, Math.min(top, window.innerHeight - elements.photoMenu.offsetHeight - 10))}px`;
  if (event.type === "keydown") elements.photoMenu.querySelector("button")?.focus({ preventScroll: true });
}

function renderPhotoMenu(photoIndex) {
  const title = document.createElement("div");
  title.className = "photo-menu-title";
  title.textContent = photoIndex >= 0 ? t("photoNumber", { number: photoIndex + 1 }) : t("canvasActions");
  const createButton = action => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.action = action;
    button.classList.toggle("danger", action === "removePhoto" || action === "clearCanvas");
    button.disabled = action === "clearCanvas" && photos.length === 0;
    button.setAttribute("role", "menuitem");
    button.innerHTML = `${photoToolIcons[action]}<span>${t(action)}</span>`;
    return button;
  };
  const photoActions = photoIndex >= 0
    ? ["rotateLeft", "rotateRight", "flipHorizontal", "flipVertical", "cropReset", "removePhoto"].map(createButton)
    : [];
  const separator = document.createElement("div");
  separator.className = "photo-menu-separator";
  separator.setAttribute("role", "separator");
  elements.photoMenu.replaceChildren(
    title,
    ...photoActions,
    ...(photoActions.length > 0 ? [separator] : []),
    createButton("addPhotos"),
    createButton("clearCanvas")
  );
}

function closePhotoMenu() {
  elements.photoMenu.hidden = true;
}

function clearPhotos() {
  cancelPhotoDrag();
  if (outputBusy) return;
  loadVersion++;
  clearTimeout(renderTimer);
  renderVersion++;
  disposePhotos(photos);
  photos = [];
  selectedPhotoIndex = 0;
  syncConditionalControls();
  syncPhotoControls();
  disableExports();
  elements.canvas.hidden = true;
  elements.emptyPreview.hidden = false;
  showStatus(null);
}

function removeSelectedPhoto() {
  cancelPhotoDrag();
  if (outputBusy) return;
  const removed = photos[selectedPhotoIndex];
  if (!removed) return;
  clearTimeout(renderTimer);
  renderVersion++;
  photos = photos.toSpliced(selectedPhotoIndex, 1);
  disposePhotos([removed]);
  selectedPhotoIndex = Math.min(selectedPhotoIndex, Math.max(0, photos.length - 1));
  syncConditionalControls();
  syncPhotoControls();
  if (photos.length > 0) {
    renderSelection();
    return;
  }
  disableExports();
  elements.canvas.hidden = true;
  elements.emptyPreview.hidden = false;
  showStatus(null);
}

function movePhoto(fromIndex, toIndex) {
  cancelPhotoDrag();
  if (outputBusy) return;
  if (fromIndex === toIndex || toIndex < 0 || toIndex >= photos.length) return;
  const selectedPhoto = photos[selectedPhotoIndex];
  const nextPhotos = [...photos];
  const [movedPhoto] = nextPhotos.splice(fromIndex, 1);
  nextPhotos.splice(toIndex, 0, movedPhoto);
  photos = nextPhotos;
  selectedPhotoIndex = photos.indexOf(selectedPhoto);
  syncPhotoControls();
  scheduleRender();
}

function syncConditionalControls() {
  elements.customGridFields.hidden = elements.gridMode.value !== "custom";
  elements.photoSizeFields.hidden = elements.gridMode.value !== "fixed";
  elements.previewStage.dataset.orientation = elements.orientation.value;
}

function scheduleRender({ keepPreviewPlan = false } = {}) {
  cancelPhotoDrag();
  clearTimeout(renderTimer);
  closePhotoMenu();
  if (photos.length === 0) return;
  renderVersion++;
  disableExports(keepPreviewPlan);
  showStatus("processing");
  renderTimer = setTimeout(() => {
    renderTimer = 0;
    renderSelection(keepPreviewPlan);
  }, RENDER_DELAY_MS);
}

async function renderSelection(keepPreviewPlan = false) {
  cancelPhotoDrag();
  if (photos.length === 0) return;
  const version = ++renderVersion;
  let plan;
  disableExports(keepPreviewPlan);
  showStatus("processing");

  try {
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (version !== renderVersion) return;
    cancelPhotoDrag();
    plan = readPlan();
    const previewPlan = fitSheetPlanToPixels(plan, PREVIEW_MAX_PIXELS);
    renderSheet(elements.canvas, photos, previewPlan, elements.cutMarks.checked);
    if (version !== renderVersion) return;

    const hasOverflow = plan.overflowCount > 0;
    lastPlan = hasOverflow ? null : plan;
    lastPreviewPlan = previewPlan;
    elements.canvas.hidden = false;
    elements.emptyPreview.hidden = true;
    syncPhotoControls();
    elements.saveFile.disabled = hasOverflow;
    elements.print.disabled = hasOverflow;
    if (hasOverflow) {
      showStatus("gridTooSmall", { selected: photos.length, capacity: plan.cells.length });
    } else {
      showPlanReady(plan);
    }
  } catch (error) {
    if (version !== renderVersion) return;
    lastPreviewPlan = null;
    elements.canvas.hidden = true;
    elements.emptyPreview.hidden = false;
    lastPlan = null;
    showStatus(errorMessageKey(error));
  }
}

function readPlan() {
  const paper = resolvePaper(elements.paper.value, elements.orientation.value);
  return buildSheetPlan({
    paper,
    dpi: Number(elements.dpi.value),
    marginMm: Number(elements.margin.value),
    gapMm: Number(elements.gap.value),
    gridMode: elements.gridMode.value,
    columns: Number(elements.columns.value),
    rows: Number(elements.rows.value),
    photoWidthMm: Number(elements.photoWidth.value),
    photoHeightMm: Number(elements.photoHeight.value),
    photoFit: elements.photoFit.value,
    photoCount: photos.length,
    allowOverflow: true
  });
}

function buildFilename(plan) {
  const contents = photos.length === 1 ? `${plan.cells.length}-copies` : `${photos.length}-photos`;
  return `${elements.paper.value}_${contents}_${plan.dpi}dpi`;
}

async function saveSelectedFile() {
  if (!lastPlan || outputBusy) return;
  const plan = lastPlan;
  const filename = buildFilename(plan);
  const format = elements.exportFormat.value;
  const photosSnapshot = snapshotPhotosForRender(photos);
  const drawCutMarks = elements.cutMarks.checked;
  setOutputBusy(true);
  try {
    showStatus("processing");
    await new Promise(resolve => requestAnimationFrame(resolve));
    const blob = await createOutputBlob(format, plan, photosSnapshot, drawCutMarks);
    downloadBlob(blob, `${filename}.${format}`);
    showPlanReady(plan);
  } catch {
    showExportFailure(plan);
  } finally {
    setOutputBusy(false);
  }
}

async function printSheet() {
  if (!lastPlan || outputBusy) return;
  const plan = lastPlan;
  const photosSnapshot = snapshotPhotosForRender(photos);
  const drawCutMarks = elements.cutMarks.checked;
  setOutputBusy(true);
  try {
    showStatus("processing");
    await new Promise(resolve => requestAnimationFrame(resolve));
    const png = await createOutputBlob("png", plan, photosSnapshot, drawCutMarks);
    await printController.print(png, plan);
    showPlanReady(plan);
  } catch {
    showExportFailure(plan);
  } finally {
    setOutputBusy(false);
  }
}

async function createOutputBlob(format, plan, photosSnapshot, drawCutMarks) {
  if (!canAttemptFullResolutionExport(plan)) throw new Error("OUTPUT_TOO_LARGE");
  const exportCanvas = document.createElement("canvas");
  try {
    renderSheet(exportCanvas, photosSnapshot, plan, drawCutMarks, Infinity);
    if (format === "pdf") return await canvasToPdfBlob(exportCanvas, plan);
    if (format === "jpg") return await canvasToJpeg(exportCanvas, plan.dpi);
    return await canvasToPng(exportCanvas, plan.dpi);
  } finally {
    exportCanvas.width = 0;
    exportCanvas.height = 0;
  }
}

function showPlanReady(plan) {
  showStatus("ready", {
    width: plan.widthPx,
    height: plan.heightPx,
    columns: plan.columns,
    rows: plan.rows,
    copies: plan.cells.length
  });
}

function showExportFailure(plan) {
  const failure = getExportFailureDetails(plan);
  showStatus(failure.key, failure.values);
}

function disableExports(keepPreviewPlan = false) {
  lastPlan = null;
  if (!keepPreviewPlan) lastPreviewPlan = null;
  syncSelectionOutline();
  elements.saveFile.disabled = true;
  elements.print.disabled = true;
}

function setOutputBusy(busy) {
  cancelPhotoDrag();
  outputBusy = busy;
  if (busy) {
    closePhotoMenu();
    hideReorderTarget();
  }
  const controls = [
    elements.paper, elements.orientation, elements.dpi, elements.gridMode,
    elements.columns, elements.rows, elements.photoWidth, elements.photoHeight,
    elements.photoFit, elements.margin, elements.marginValue, elements.gap,
    elements.cropReset,
    elements.gapValue, elements.cutMarks, elements.replacePhotos, elements.addPhotos,
    elements.exportFormat, elements.trimPhotos
  ];
  for (const control of controls) control.disabled = busy;
  syncCropControls();
  elements.saveFile.disabled = busy || !lastPlan;
  elements.print.disabled = busy || !lastPlan;
  elements.previewStage.classList.toggle("output-busy", busy);
}

function trimPhotosToCapacity() {
  if (outputBusy || overflowCapacity < 1 || photos.length <= overflowCapacity) return;
  disposePhotos(photos.slice(overflowCapacity));
  photos = photos.slice(0, overflowCapacity);
  selectedPhotoIndex = Math.min(selectedPhotoIndex, photos.length - 1);
  syncPhotoControls();
  renderSelection();
}

function errorMessageKey(error) {
  return {
    CELLS_DO_NOT_FIT: "cellsDoNotFit",
    INVALID_PHOTO_SIZE: "invalidPhotoSize",
    INVALID_PAPER: "invalidPaper"
  }[error?.message] ?? "error";
}

function setLocale(nextLocale) {
  closePhotoMenu();
  locale = nextLocale;
  localStorage.setItem("locale", locale);
  document.documentElement.lang = locale;
  document.title = t("pageTitle");
  for (const node of document.querySelectorAll("[data-i18n]")) node.textContent = t(node.dataset.i18n);
  elements.language.textContent = locale === "ru" ? "EN" : "RU";
  elements.help.setAttribute("aria-label", t("helpTitle"));
  elements.helpClose.setAttribute("aria-label", t("helpClose"));
  elements.cropReset.setAttribute("aria-label", t("cropReset"));
  elements.cropReset.title = t("cropReset");
  elements.language.setAttribute("aria-label", t(locale === "ru" ? "switchEnglish" : "switchRussian"));
  elements.theme.setAttribute("aria-label", t(document.documentElement.dataset.theme === "dark" ? "lightTheme" : "darkTheme"));
  syncPhotoControls();
  renderStatus();
}

function setTheme(nextTheme) {
  document.documentElement.dataset.theme = nextTheme;
  localStorage.setItem("theme", nextTheme);
  elements.theme.textContent = nextTheme === "dark" ? "☀" : "☾";
  elements.theme.setAttribute("aria-label", t(nextTheme === "dark" ? "lightTheme" : "darkTheme"));
}

function showStatus(key, values = {}) {
  statusState = { key, values };
  overflowCapacity = key === "gridTooSmall" ? Number(values.capacity) || 0 : 0;
  renderStatus();
}

function renderStatus() {
  const richError = {
    outputTooLarge: ["outputTooLargeTitle", "outputTooLargeDetail"],
    exportFailed: ["exportFailedTitle", "exportFailedDetail"]
  }[statusState.key];
  const isError = Boolean(richError) || ["needPhotos", "photoMemoryLimit", "gridTooSmall", "cellsDoNotFit", "invalidPhotoSize", "error"].includes(statusState.key);
  elements.status.replaceChildren();
  elements.status.classList.toggle("status-rich-error", Boolean(richError));
  if (richError) {
    const icon = document.createElement("span");
    icon.className = "status-error-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "!";
    const copy = document.createElement("span");
    copy.className = "status-error-copy";
    const title = document.createElement("strong");
    title.textContent = t(richError[0], statusState.values);
    const detail = document.createElement("span");
    detail.textContent = t(richError[1], statusState.values);
    copy.append(title, detail);
    elements.status.append(icon, copy);
  } else {
    elements.status.textContent = statusState.key ? t(statusState.key, statusState.values) : "";
  }
  elements.status.classList.toggle("status-error", isError);
  elements.status.setAttribute("role", isError ? "alert" : "status");
  elements.status.setAttribute("aria-live", isError ? "assertive" : "polite");
  const canTrim = statusState.key === "gridTooSmall" && overflowCapacity > 0;
  elements.statusActions.hidden = !canTrim;
  elements.trimPhotos.textContent = canTrim ? t("trimPhotos", { capacity: overflowCapacity }) : "";
}

function t(key, values) {
  return translate(locale, key, values);
}
