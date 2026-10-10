# Spreadsheet attachments

A spreadsheet attached to a chat is never put in the prompt as a file. The upload is parsed in a
sandboxed dynamic worker into two things: a **summary** (the sheets as addressed rows, at most
48 KiB), stored as the attachment itself, and **every row of every sheet**, stored as JSON pages
beside it. The model reads the summary every turn; it reaches the rows through the `readSheet` tool
and the `env.<name>` workbook binding in `executeCode`. A workbook costs at most 48 KiB of prompt
whether it holds ten rows or a hundred thousand. Ported from `twinprime19/cloudflare-os`; see
the divergence inventory in `docs/fork-maintenance.md`.

## Formats

| Extension | MIME type |
|---|---|
| `.xlsx` | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` |
| `.xls` | `application/vnd.ms-excel` |
| `.xlsm` | `application/vnd.ms-excel.sheet.macroenabled.12` |
| `.xlsb` | `application/vnd.ms-excel.sheet.binary.macroenabled.12` |
| `.ods` | `application/vnd.oasis.opendocument.spreadsheet` |

CSV is a text file and takes the ordinary text path. Windows browsers label `.csv` as
`application/vnd.ms-excel`, which fails the content check; upload it as `.txt`. The upload may be up
to 10 MiB; it works with every model provider, since only text reaches the model.

## What the model sees

One heading line, one legend line, then per sheet a heading and its rows. Each non-empty row is
`19 C="CC2 (Palm Heights)" E=74635 F=816`: the Excel row number, then `COLUMN=value` for every
non-empty cell. Dates are ISO strings, text is quoted when it holds a space, `"` or `=`, a cell's
own line breaks become spaces, and a run of more than 8 adjacent numbers collapses to
`O..AV=34 nums (first … last)`. Each sheet is shown as whole (32 KiB or less), an outline of its
row bands (6 KiB or less), or heading only, whichever the workbook's 48 KiB budget allows; every
sheet's heading is reserved first so a large sheet never hides a later sheet's name.

The text is replayed under an untrusted-data notice (`UNTRUSTED_SPREADSHEET_NOTICE`), followed by
the names of the two ways to the full data. `readSheet` results carry the same notice. A cell is
data to report on, never an instruction; the tool description says so too.

`readSheet(file, sheet, range?)` reads `A150:AV160` or `150:160` (1-based, inclusive; default rows
1-50), at most 200 rows and 24 KiB per call, never collapsing a numeric run, and is recorded so a
replay reuses the text. In `executeCode`, `env.<name>.listSheets()` and
`.getRows(sheet, start?, end?)` (0-based, at most 20,000 rows per call) return the values;
`describeBinding("<name>")` prints the API. The binding is read-only and opens only for the owning
chat's own agent. The name comes from the file name (`big.xlsx` becomes `big_xlsx`, a second one
`big_xlsx_2`) and is derived the same way on every replay, and in the compaction checkpoint.

Cell values: formulas are the last value the spreadsheet stored (nothing is recalculated and the
formula text is not read), errors are their text (`#N/A`), empty cells are `null`. Charts, images,
pivot caches, styles, number formats and macros are ignored.

## Safety limits

The parser reads untrusted files. It runs in a fresh dynamic worker per upload (`env: {}`, no
bindings, `globalOutbound: null` so no network, `cpuMs` 30,000), loaded from a bundle that is the
only place the spreadsheet library exists. Inside it:

| Limit | Value | Why |
|---|---|---|
| Raw upload | 10 MiB | Checked before parsing |
| Archive content, measured by inflating | 32 MiB | A ZIP's declared sizes are claims; the bytes are counted as they inflate, in 16 KiB slices |
| Archive entries | 5,000 | Each entry costs the inflater a stream; real workbooks hold tens |
| Rows across all sheets | 250,000 | Read stops one row past the ceiling |
| Row JSON across all sheets | 32 MiB | A repeated shared string encodes to megabytes |
| One stored page, hence the largest row | 1 MiB | A row is never split |
| Summary | 48 KiB | Replayed every turn |

What the limits cannot see (an ODS row declaring millions of repeats) exhausts the isolate's
memory or CPU: the upload is refused as too large and the workspace is untouched. Formulas are
never evaluated and external links are never followed; the library only reads cached values, and
the isolate could not fetch them if it tried. A parse or stream that fails leaves nothing stored, and
an attachment becomes usable only once its last page is written.

The library is `@e965/xlsx` 0.20.3, pinned exactly. It is SheetJS Community Edition 0.20.3 republished
to the public npm registry; `xlsx` on npm itself stops at 0.18.5, which has known vulnerabilities
(prototype pollution, ReDoS) fixed only in releases SheetJS serves from its own CDN. The
republished package's code is byte-identical to the CDN tarball (`xlsx-0.20.3.tgz`, sha256
`8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8`): only `package.json` and the
README differ. Re-check that with `npm pack @e965/xlsx@<version>` against the CDN file before
changing the pin, and prefer `xlsx` itself if SheetJS ever publishes a fixed version there.
