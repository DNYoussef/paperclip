# Connascence Scan Summary

- Project: `paperclip`
- Path: `D:\Projects\paperclip`
- Git branch: `fix/p0x-paperclip`
- Git commit: `4ca66e98b4c323cbed5f22a8f8751a8703329dc0`
- Dirty before scan: `False`
- Scan succeeded: `True`
- Python files staged: `0`

## Commands Run
- `C:\Python312\python.exe -m analyzer C:\Users\17175\Desktop\_SCRATCH\connascence-portfolio-scan-2026-06-06\raw-results\paperclip\mirror --format json --output C:\Users\17175\Desktop\_SCRATCH\connascence-portfolio-scan-2026-06-06\raw-results\paperclip\connascence.raw.json --no-duplication --compliance-threshold 0 --max-god-objects 999999` (exit 0)
- `connascence_portfolio_runner.py generate-sarif-from-json D:\Projects\paperclip\docs\connascence\scan-2026-06-06\connascence.json` (exit 0)
- `C:\Python312\python.exe -m analyzer.ast_engine --path C:\Users\17175\Desktop\_SCRATCH\connascence-portfolio-scan-2026-06-06\raw-results\paperclip\mirror --analyzer god_object --output C:\Users\17175\Desktop\_SCRATCH\connascence-portfolio-scan-2026-06-06\raw-results\paperclip\god-object.raw.json` (exit 0)

## Counts By Severity

- none: 0

## Counts By Type

- none: 0

## Top Files

- No files with findings.

## Top 10 Actionable Findings

No actionable findings were reported by the Python analyzer.

## Tool Limitations

- Connascence currently analyzes Python files only; non-Python coupling is not covered.
- Source-bearing fields and literal values were stripped or redacted before writing artifacts.
- Excluded directories and sensitive data patterns were not staged into the scan mirror.
- No Python files were staged; this is a partial/non-Python result, not evidence of no coupling.

## Next Cleanup Recommendations

### 1. Quick Wins
- Review the top findings and remove low-risk local coupling first.

### 2. Medium Refactors
- No medium refactor category dominated this scan.

### 3. Large Architectural Work
- Use module or service boundaries to isolate recurring high-count hotspots.
