# touchtree

A Files pane for the **Claude Code desktop app** that shows, live, which files Claude reads, edits and commits, right in your project tree.

> [!IMPORTANT]
> touchtree is built for the **Claude Code desktop app** (the Code tab). It has not been tested in the terminal `claude` CLI, and the pane is not expected to display there.

## Features

- **Status card:** what Claude is doing right now ("Claude is reading `App.ts`"), or what it did last turn ("Claude edited 3 files", "Claude committed 2 files"), with your branch, commits ahead, and lines added and removed.
- **Claude touched:** a list of every file Claude read or edited this session, with its folder, lines changed, and its state.
- **Project tree:** opens one folder at a time and expands on its own to show the file Claude is working on.
- **Activity highlights:** files Claude read are highlighted purple, edited orange, and committed green, each with a matching pill (`read`, `edited`, `committed`).
- **Folder colours:** a folder takes the colour of the strongest action inside it, in the order committed, edited, read. While Claude works in a folder, a light shimmer sweeps across its name.
- **Shell changes count too:** files Claude creates or changes with shell commands show as edits, not only files changed with its file tools.
- **Commits:** when Claude runs `git commit`, every file in that commit turns green.
- **Tools:** find a file by name, collapse all, show file sizes, hide hidden files, and move up a folder or back to the project.

## Requirements

- The Claude Code desktop app, with a Claude Code engine that supports plugin hooks (tested with 2.1.293).
- `git` on your `PATH` for branch, change and commit information. Without git the tree still works.
- Tested on Windows.

## Install

touchtree's repository is its own plugin marketplace. In a Claude Code session in the desktop app, run:

```text
/plugin marketplace add ItsJustLeo22/touchtree
/plugin install touchtree@touchtree
```

Then open the pane with:

```text
/touchtree
```

The pane opens on its own at the start of each session; run `/touchtree` to bring it back if you close it.

## Colours

| Colour | Meaning |
| --- | --- |
| Purple | Claude read the file |
| Orange | Claude edited the file |
| Green | The file was committed |
| Yellow | Uncommitted changes Claude didn't make |

## Privacy

touchtree runs entirely on your machine. It lists folders in your project and runs read-only git commands (`status`, `diff`, `rev-parse`, `ls-files`). It makes no network requests and sends nothing anywhere. The touched-files list is kept for the current session only.

## Known limits

- In a brand-new folder that git doesn't track yet, files show as new without line counts.
- The change totals on the status card cover the whole git repository, not only the open folder.
- The tree shows up to 400 rows; collapse folders or use search for larger projects.
- The touched-files list resets when the desktop app restarts.

## Acknowledgements

The read, edit and commit colour scheme and the shimmer follow the style of [claude-code-filetree](https://github.com/data-goblin/claude-code-filetree), a terminal file tree for Claude Code.

## License

[MIT](LICENSE)
