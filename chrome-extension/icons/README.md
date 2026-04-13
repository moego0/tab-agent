# Icons

The manifest expects:

- `icon16.png`, `icon32.png`, `icon48.png`, `icon128.png`

Setup screenshots for the main README:

- `step 1.png`, `step 2.png`, `step 3.png` — Chrome “Manage extensions”, “Load unpacked”, and folder selection.

Generate brand PNGs from the repo root (Windows, requires `System.Drawing`), if `scripts/generate-brand-icons.ps1` exists:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/generate-brand-icons.ps1
```
