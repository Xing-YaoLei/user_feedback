# Probe vibration peaks by process

`probe_sync.py` maps vibration-probe samples onto controller UTC time and
reports, per process, the valid sample count and the peak amplitude.

## Why calibration is needed

The probe counts on its own local counter, which resets to zero on every
reboot. A raw count therefore does not identify a moment until it is pinned to
controller time. The sync file provides several `(count, utc_us)` anchor points
per device session; a sample is placed by linear interpolation between the two
adjacent anchors that bracket its count. Samples outside the anchored range are
reported as uncalibrated.

A session is rejected as a whole (and reported as its own entry) when its
anchors are self-inconsistent:

* the same count maps to two different UTC times, or
* UTC time moves backwards as the count increases.

Rejected sessions produce no calibrated samples.

## Inputs

Probe CSV (`probe_csv`), one row per sample:

```
device_id,session_id,count,amplitude
AQ-01,S1,240,1.38
```

Sync CSV (`sync_csv`), one row per anchor point:

```
device_id,session_id,count,utc_us
AQ-01,S1,100,1000000
AQ-01,S1,300,1040000
```

Process JSON (`process_json`), a list (or an object with a `processes` list) of:

```json
{"device_id": "AQ-01", "process_id": "OP-1040",
 "start_utc_us": 1020000, "end_utc_us": 1060000}
```

Process intervals on one device never overlap. Windows are half-open:
`[start_utc_us, end_utc_us)`.

CSV headers are optional; blank lines and `#` comment lines are ignored. `row`
in the output is the 1-based input line number of the original sample.

## Rules applied

* Interpolation is exact and never rounded, so a sample sitting exactly on a
  process edge is classified correctly by the half-open rule.
* A sample's process is looked up on its own device only.
* Ties on peak amplitude go to the earliest calibrated time, then to the first
  input row.
* Calibrated samples that fall into no process are listed under `Unlocated`.
* Samples that cannot be calibrated are listed under `Uncalibrated`, each with
  a reason.
* Each device session is summarised with its status (`ok`, `rejected`,
  `insufficient-anchors`, `no-anchors`) and how many of its samples could not
  be calibrated. Rejected sessions show the inconsistency that caused them.
* Overlapping process intervals on one device abort the run with an error,
  since such a sample would have no single owning process.

## Output

The text report has four sections: `Processes` (window, valid sample count,
max amplitude, and the peak detail), `Unlocated`, `Uncalibrated`, and
`Session issues`. `--json` emits the same information as structured data. Each
peak carries `calibrated_utc_us` plus, when the interpolation is not a whole
microsecond, `calibrated_utc_us_exact` with the unrounded fraction.

## Usage

```sh
python3 probe_sync.py examples/probe.csv examples/sync.csv examples/process.json
python3 probe_sync.py examples/probe.csv examples/sync.csv examples/process.json --json
```

## Tests

```sh
python3 -m unittest discover -s tests -v
```
