# Icons

The manifest expects:

- `icon16.png`, `icon32.png`, `icon48.png`, `icon128.png`

Generate them from the repo root (Windows, requires `System.Drawing`):

```powershell
powershell -ExecutionPolicy Bypass -File scripts/generate-brand-icons.ps1
```

Outputs match the **Local tab bridge** / **Local tab agent** navy + cyan brand.
