# Changelog

## 0.3.1

- Add Reading view and Split view controls, retaining the draft, compiler and
  divider position while expanding or restoring the preview width.
- Add Fit width to reset manual preview zoom.
- Jump handbook index and return links immediately to their destination near
  the top of the viewport, without also triggering a source jump.
- Restore the source safely when closing a preview from Reading view.
- Clarify catalog installation and the installable `plugin/` subdirectory.

## 0.3.0

First GitHub catalog release, based on private build 0.2.9.

- Add an installable catalog with pinned releases for Orca-managed updates.
- Include the complete plugin source, built runtime and dependency license texts.
- Preserve pasted full paths, recent-file ordering, live edits and saved PDF export.
- Isolate live preview frames even when Orca reuses a native caller id.
- Keep tab-switch selection restoration explicitly unsupported on Orca 1.4.247.
