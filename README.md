# Warning-time feature replay

Rebuilds the sensor features a warning *could* have seen at the moment it fired,
from a platform revision stream. A sensor sample whose value was corrected or
retracted **after** the warning must not change that warning's row.

## Inputs

**`--warnings`** — warning points, CSV (UTF-8, optional BOM), comma separated by default:

```csv
warning_id,warning_time
w-001,2026-11-13T08:00:00Z
w-002,2026-11-13T08:30:00+08:00
```

`warning_time` may carry any ISO-8601 offset; naive timestamps are treated as UTC.
The warning id and time columns are detected from common names (`warning_id`,
`预警ID`, `warning_time`, `预警时点`, …) or forced with `--id-col` / `--time-col`.
Duplicate warning ids are rejected.

**`--revisions`** — revision stream, one JSON object per line (JSONL):

```json
{"device_id":"dev-1","sample_id":"s-42","sample_time":"2026-11-13T07:50:00Z","received_at":"2026-11-13T07:51:03Z","revision":1,"value":21.4}
{"device_id":"dev-1","sample_id":"s-42","sample_time":"2026-11-13T07:50:00Z","received_at":"2026-11-13T08:05:00Z","revision":2,"retracted":true}
```

Each revision carries the device, sample id, sample time, platform receive time,
revision number, and either a new value (one of `value` / `new_value` / `数值` …)
or a retraction marker (`retracted: true`, `event: "retracted"`, `撤回` …).

Input invariants are enforced: device and sample time are fixed per sample id,
and revision numbers must be integers. Re-delivering the identical revision line
is harmless — the earliest receive time is kept, so late duplicates cannot
retroactively change a row. When a revision is marked as a retraction any value
on the same line is ignored.

## Rules

For a warning at `T`:

1. Window is `[T − 30min, T)`: the start is included, the warning instant is not.
   Membership is decided by the **sample time**, never by receive time.
2. For each sample in the window, take the **highest revision number the platform
   had received at or before `T`**. A sample whose first delivery arrives after
   `T` is therefore invisible.
3. If that visible revision is a retraction, the sample is dropped from the window.
4. Output per warning: valid sample count, mean of the used values, seconds from
   the most recent used sample to `T`, and the sample ids with the revision
   numbers used. Empty windows leave mean and gap blank.

The stream is order-independent: input line order does not matter, only
`received_at`.

## Usage

```sh
python3 replay.py --warnings warnings.csv --revisions revisions.jsonl -o features.csv
python3 replay.py --warnings warnings.csv --revisions revisions.jsonl --format json
python3 replay.py --warnings warnings.csv --revisions revisions.jsonl \
    --baseline features.csv            # re-check an earlier run row by row
python3 replay.py --warnings warnings.csv --revisions revisions.jsonl --self-check
```

Output columns:

```csv
warning_id,valid_sample_count,mean,last_sample_gap_seconds,sample_ids,revision_numbers
w-001,3,21.4333,45.5,s-40|s-41|s-42,1|2|1
```

`sample_ids` and `revision_numbers` are `|`-separated and positionally paired,
ordered by sample time. `--format json` / `jsonl` emit the same data as objects.

### Verifying against an earlier run

When a re-export adds revisions that arrived after the warnings, compare against
the CSV produced by the previous run:

```sh
python3 replay.py ... -o features.csv --baseline features.csv
```

`--baseline` reads the previous file, compares every warning id row by row, and
exits `1` listing any column that changed (it does not write the new file when a
mismatch is found). Exit codes: `0` ok, `1` verification mismatch, `2` bad input.

`--self-check` independently re-derives every feature from a shuffled stream and
from a streaming replay that only applies revisions received by `T`; it fails on
any difference.

## Tests

```sh
python3 -m unittest discover -s tests -v
# or
./run_tests.sh
```

Stdlib only; no third-party dependencies.
