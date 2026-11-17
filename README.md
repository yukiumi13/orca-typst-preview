# Typst Preview for Orca

Last updated on 2026-11-17 at commit `de2b018`.

Edit Typst beside a live Tinymist preview, on a local or remote workspace using
Orca's existing connection. Choose a recently modified file or paste its full
path; unsaved edits appear in the preview, and saved source exports a sibling PDF.

## Install once, receive updates

Requires **Orca desktop 1.4.247+**, Tinymist on the compilation host, and Node.js
22+ on remote hosts. Local previews use Orca's bundled Node. Install this on the
machine running the desktop app, even when your files are remote.

1. Open **Settings → Plugins → Plugin settings → Catalog sources…**. The plugin settings button is beside **Add plugin**.
2. Add `https://github.com/yukiumi13/orca-typst-preview.git`, ref **main**.
3. Find **Typst Preview** in that catalog, install it, and approve its listed access.
4. Keep **Update plugins automatically** on.
5. Open a `.typ` file and select **Preview** beside **Source**.

Use **Catalog sources…** for this repository. **Add plugin → From a Git URL…**
expects `orca-plugin.json` at the repository root and will reject this catalog.
If you downloaded GitHub's source ZIP for a folder installation, select its
`plugin/` subdirectory. A folder installation does not receive catalog updates.

If you used an earlier ZIP/folder installation, disable `local.typst-preview`
after installing the catalog version (`yukiumi13.typst-preview`). Transfer any
custom Tinymist, Node, font or package settings once. Reopen the file tab after
this one-time migration so the new editor is loaded.

Each release is pinned to a commit and a SHA-256 content hash. Ordinary updates
from this repository keep the existing approval; updates requesting additional
access need review. Orca 1.4.247 checks at startup and every six hours and waits
twelve hours after first seeing a non-official release before automatically
installing it. To get a fix sooner:

1. Return to the main **Settings → Plugins** list.
2. Click the circular-arrow **Refresh catalogs** button in the list toolbar.
3. Open **Typst Preview** and click **Update 0.3.1** (or the newer listed version).
4. Save edits and reopen the file tab to load the updated editor.

On Orca 1.4.247, **Check for update** in a plugin's menu checks the cached catalog;
it does not fetch GitHub. It can report the installed version until you use
**Refresh catalogs**. The twelve-hour delay applies to automatic installation,
not a manual update after refreshing. If the catalog still looks old, open
**Plugin settings → Catalog sources**, check that this repository uses ref
`main`, and inspect its refresh error/status. Local folder installations need
the one-time migration above to receive catalog updates.

No ZIP download or folder reinstallation is needed for subsequent catalog updates.

## Use

- Paste the full `.typ` path from Orca's tab header and press Enter, or select
  a file from the modification-time-sorted list. A pasted path can correct the
  workspace automatically among known workspaces on the same host.
- Drag the divider to resize the editor and preview. **Reveal cursor** locates
  the source position in the preview.
- **Reading view** fills the editor with the preview; **Split view** restores
  the source and previous divider position without restarting the compiler.
  The current reading position is retained as the width changes.
- **Fit width** resets manual zoom. It does not change the document's paper size.
- Click a handbook index, section or return link to jump immediately to its
  destination near the top of the viewport. These links do not move source focus.
- The live preview includes unsaved edits. The adjacent PDF uses saved source.
- **Close preview** releases the compiler when its last view closes.

The plugin is a **trusted worker**: it runs Node code as your user, launches
Tinymist, and uses the owning Orca app's existing connection for remote helper
terminals. It declares workspace-reading and its own settings capabilities.
It does not manage a separate SSH connection or pairing credentials. All browser
resources are bundled; no CDN scripts are loaded.

## Current limits

- Desktop only; browser-only Orca clients are unsupported.
- Orca 1.4.247 does not expose a stable document/tab identity to custom editors.
  Live frames are isolated, but switching away and back can recreate the frame
  and require choosing or pasting the file again. This release does not claim
  automatic restoration across tab switches.
- Workspace detection is a suggestion based on desktop context. Use the path
  field when it suggests the wrong workspace. Do not select a different source
  file from the one open in the tab.
- Remote workspace discovery and transport use the installed app's internal
  profile reader/runtime client. Tested with Linux Orca 1.4.247; future app
  changes can require a plugin update. The owner's Mac has not been exercised
  by the automated integration tests.
- The renderer was extracted from Tinymist's 2026-11-03 build (Typst 0.15.1).
  Other compiler versions are not yet part of the compatibility evidence.
- Terminal transport contributes startup latency. Opening its helper terminal
  shows encoded `TPREV_…` packets; those are preview data.
- File size limit: 8 MiB. File-list scans are bounded and exclude Git-ignored
  files; an explicit path can open an ignored file inside a known workspace.
- Dependency-only changes refresh the live preview; save the main source or
  reopen Preview to refresh its exported PDF.

## Source and releases

| Path | Purpose |
| --- | --- |
| `source/` | Maintained editor, worker, renderer, tests and build inputs |
| `plugin/` | Committed installable build, selected by the catalog |
| `orca-catalog.json` | Releases with exact commit/hash pins |
| `scripts/package.mjs` | Build the source and refresh `plugin/` |

```sh
cd source
npm ci
orca plugin types .
npm run typecheck
npm test                # requires Tinymist on PATH
cd ..
node scripts/package.mjs
orca plugin validate plugin --json
```

Bump `source/orca-plugin.json` and package versions, build and validate, then
commit the source and `plugin/` together. Run `orca plugin release-entry plugin
--json` at that commit and prepend its release entry to `orca-catalog.json`.
Commit the catalog, tag the resulting commit `vX.Y.Z`, and push both. Never
replace the files of an already published version. Catalog-only commits do not
change the installable plugin hash because `source.path` points to `plugin/`.

The original release passed 31 Node tests, browser live-edit/source-preservation
checks, and an isolated Linux Orca 1.4.247 paired-host rendering/tab-isolation
check. These establish those fixtures, not every desktop or network setup.

## License

Apache-2.0; see [LICENSE](LICENSE). Tinymist attribution is in
[plugin/vendor/NOTICE.md](plugin/vendor/NOTICE.md). Browser dependency license
texts are included in [plugin/THIRD_PARTY_NOTICES.txt](plugin/THIRD_PARTY_NOTICES.txt).
