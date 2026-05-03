# Contributing to ASPOS Print Agent

Contributions are welcome — bug fixes, platform improvements, and documentation updates especially so.

## Reporting issues

Before opening an issue:

- Check [existing issues](https://github.com/stszone/aspos-print-agent/issues) to avoid duplicates
- Include your platform (OS, Node.js version), the full error message or log output, and steps to reproduce

For **security vulnerabilities**, do not open a public issue — see [SECURITY.md](SECURITY.md).

## Pull requests

1. Fork the repo and create a branch from `main` with a descriptive name (e.g. `fix/windows-path-resolution` or `feat/usb-printer-support`)
2. Keep changes focused — one logical change per PR
3. Add or update tests for any changed behaviour (`npm test` must pass)
4. Run `npm run lint` and fix any warnings before pushing
5. Open the PR against `main` with a clear description of what changed and why

## Code style

- ES modules (`import`/`export`); no CommonJS `require()`
- No comments that explain *what* the code does — only *why* when non-obvious
- No TypeScript; plain JavaScript with JSDoc where helpful
- No unnecessary abstractions — keep it simple and direct

## Development setup

```bash
npm install
cp .env.example .env  # fill in values from your ASPOS admin panel
npm test              # runs the full test suite offline (no live backend needed)
npm run lint
```

## Questions

Open a [discussion](https://github.com/stszone/aspos-print-agent/discussions) for anything that isn't a bug or feature request.
