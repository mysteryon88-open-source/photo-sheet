# Photo Sheet

Create print-ready photo sheets directly in your browser. Arrange images, choose the paper and exact photo size or grid, then export to PNG, JPG, or PDF.

> Photos never leave your device. Photo Sheet has no server, uploads, tracking, runtime dependencies, or installation step.

## Highlights

- Works locally and remains fully offline.
- Accepts JPG, PNG, WEBP, and BMP images.
- Supports common photo-paper sizes plus A4 and A3, in portrait or landscape orientation.
- Builds automatic layouts, exact-size photo layouts, or custom grids with adjustable margins and spacing.
- Fits as many exact-size photos as possible on the selected paper and centres the occupied grid.
- Repeats a single photo across the grid or arranges any number of different photos that fit on the sheet.
- Reorders photos directly on the sheet by dragging.
- Rotates, flips, removes, and adds photos from the sheet context menu.
- Adds optional crop marks.
- Exports print-ready PNG, JPG, and single-page PDF files with the selected physical size and DPI.
- Prints directly from the browser.

## Quick start

1. Download or clone the repository.
2. Open `index.html` in a modern browser.

That is all.

## How to use

1. Choose or drop one or more photos onto the sheet.
2. Select the paper size, orientation, and DPI.
3. Use the automatic layout, enter the desired printed cell width and height, or switch to a custom grid. In cell-size mode, choose whether to fit each photo entirely or fill the cell with cropping.
4. Adjust the margins, spacing, and crop marks.
5. Drag photos on the sheet to change their print order.
6. Right-click a photo to rotate, flip, or remove it.
7. Choose PNG, JPG, or PDF and save the result, or print at **100% / Actual size**.

With one selected image, a custom grid fills every cell with a copy of that image. With multiple images, unused custom-grid cells remain empty.

### Keyboard controls

- `Left` / `Right` — select the previous or next photo.
- `Alt` + `Left` / `Right` — move the selected photo.
- `Shift` + `F10` — open the context menu.
- `Escape` — close the context menu.

## Limits

- PDF export currently creates one page.
- Very large paper and DPI combinations use a reduced-resolution preview while saving and printing still render at the selected DPI. Full-resolution output can take longer or fail if the browser runs out of memory.
