# Hermes Beads plugin

Hermes Beads is a read-only unified plugin for browsing a Beads project from Hermes Desktop. The Python backend runs fixed `bd --readonly --json` commands. The Desktop pane shows Ready, Open, In progress, and Blocked issues, parent-child structure, search results, and issue details.

## Features

- Four bounded issue views with counts and manual refresh.
- Parent-child rows with local expand and collapse controls.
- Cycle-safe display. Malformed parent cycles do not hide issues.
- Search across issue IDs, titles, descriptions, and notes.
- Existing issue detail with descriptions, design notes, acceptance criteria, blockers, and relations.
- Optional assignee and timestamp display.
- A native pane tab in the Files right-sidebar zone.

The plugin does not create, edit, close, or delete Beads issues.

## Prerequisites

- Hermes Desktop with unified plugin support.
- A Hermes Project whose selected folder is below `/home/hermes/workspace` on the connected gateway.
- The `bd` executable on the gateway host.
- A Beads workspace in the selected project directory.

## Install

Install the repository as a unified plugin directory named `beads`:

```bash
export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
git clone https://github.com/dominikmayer/hermes-beads.git "$HERMES_HOME/plugins/beads"
hermes plugins enable beads
```

If you already have the source, copy the complete repository to `$HERMES_HOME/plugins/beads` instead. Do not copy only `desktop/plugin.js`. The Agent backend and the Desktop plugin are two halves of the same package.

After installation, open **Capabilities → Plugins → Beads** in Hermes Desktop:

1. Enable the **Agent** switch for each profile that needs the Python API.
2. Enable the **Desktop** switch for the app-level pane.
3. Restart the gateway after enabling the Agent half or changing `dashboard/plugin_api.py`. Use **Restart gateway** from the command palette, or restart the app-managed backend.
4. If the pane does not reload after a Desktop-only change, run **Reload desktop plugins** from the command palette.

The Desktop half is materialized into the app-level desktop plugin directory. Edit the unified source repository, not that generated copy.

## Use the pane

Open a Hermes Desktop Project inside a Beads repository. The pane resolves the deepest active Hermes Project folder that contains the current working directory. The backend canonicalizes that folder and rejects roots outside `/home/hermes/workspace`, redirected Beads contexts, and Beads data directories that escape the project.

Select a status count to load that view. Parent issues appear above children only when both issues are present in the current bounded response. A child whose parent is outside the response remains visible as a root and shows the missing parent ID. Expand and collapse state stays local to the current connection, profile, requested root, canonical root, and view.

Type in the native search field to search active issues. The pane waits briefly before sending the query. Search performs three fixed reads:

- ID and title search.
- Description search.
- Notes search.

Results keep that command order, merge duplicate issue IDs, and show at most 100 issues. Selecting a result opens the normal issue detail. **Back** returns to the same search source. Clearing the field restores the previously selected status view.

Search does not poll on an interval. It refetches after the query changes, when the window regains focus, or when you select **Refresh**. Visible overview and status views poll every 15 seconds. Visible detail views poll every 30 seconds. Hidden pane polling stops.

## Right-sidebar behavior

Beads initially opens as a tab beside **Files**. If you drag the pane elsewhere, Hermes keeps that placement on later loads.

Use the titlebar right-sidebar control or `mod+j` to collapse or expand the right sidebar without unloading Beads.

Native **Close** has different semantics. Closing the sole Beads pane disables the Desktop half of the plugin. Re-enable **Beads** in **Capabilities → Plugins** to restore it.

## Read-only caveat

Every Beads subprocess includes `--readonly`. Beads reads can still update Beads metadata or Dolt file modification times. Treat the plugin as application-level read-only, not as a guarantee that every file timestamp remains unchanged.

## Troubleshooting

### Beads backend unavailable

Enable the Agent half for the active profile, then restart that gateway. The Desktop switch alone does not mount the Python API.

### Desktop Project required

Open a Hermes Desktop Project. The pane does not infer a repository from an arbitrary path without a matching Project.

### No Beads project

Confirm that the resolved Project folder contains a valid Beads workspace:

```bash
(cd /absolute/project/root && bd --readonly --json context)
```

Redirected Beads contexts and data directories outside the selected repository are rejected.

### Pane disappeared after Close

Open **Capabilities → Plugins** and re-enable the Beads Desktop switch. Use the sidebar collapse control or `mod+j` when you only want to hide the right sidebar temporarily.

## Architecture

`dashboard/plugin_api.py` is the security and normalization boundary. It validates project roots and issue IDs, discovers the `bd` executable from a fixed path, runs fixed argument vectors in isolated process groups, limits output, normalizes errors, and returns stable JSON.

`desktop/plugin.js` is a self-contained runtime module. It owns pure hierarchy and navigation transformations, React Query lifecycles, retained response guards, rendering, storage, and pane registration. `tests/plugin-loader.mjs` supplies the minimal Desktop SDK and React runtime used by renderer tests.

### Stable issue card

```text
IssueCard
  root
  id
  title
  status
  priority
  type
  assignee
  updatedAt
  blockerIds
  parentId
```

Direct `parent` or `parent_id` fields take precedence. A typed `parent-child` dependency is only a compatibility fallback. Blocking dependencies remain separate from `parentId`.

### Stable search response

```text
IssueSearch
  root
  query
  issues
  observedAt

IssueSearchHit
  all IssueCard fields
  matchKinds
```

`matchKinds` is an ordered subset of `id_or_title`, `description`, and `notes`.

## Verify changes

Run these commands from the plugin repository:

```bash
node --test --loader ./tests/plugin-loader.mjs tests/test_plugin_js.mjs
"$(dirname "$(readlink -f "$(command -v hermes)")")/python" -m unittest tests/test_plugin_api.py
hermes plugins validate .
hermes plugins doctor . --ci
git diff --check
```
