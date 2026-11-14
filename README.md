# Participant linkage export

Links the study's instrument measurements (CSV) and field observations (TSV)
to one another through a shared participant pseudonym, for **one approved
purpose per export**.

Instrument records are identified by a device registration number, field
records by an observation registration number. A crosswalk maps each source's
registration number to the study master id. A JSON manifest lists, by master
id and purpose, which sources the participant's records may be used for. A
record enters a result file only when:

1. its registration number resolves to exactly one master id in its own
   source's part of the crosswalk, and
2. that source is approved for that participant under the export purpose.

Everything else goes to an internal rejection list keyed by source file and
physical line number.

## Usage

```sh
participant-linkage \
    --purpose cohort-linkage \
    --manifest examples/manifest.json \
    --crosswalk examples/crosswalk.csv \
    --instrument-data examples/instruments.csv \
    --instrument-output out/instruments.csv \
    --field-data examples/observations.tsv \
    --field-output out/observations.csv \
    --rejects out/rejects.csv \
    --key-file ./export.key
```

`python -m linkage ...` works the same way without installing the package.

The key can also come from the environment (`--key-env LINKAGE_KEY`) or, for
test harnesses, as hex on the command line (`--key-hex ...`). A key file is
read as raw bytes, optionally with one trailing newline stripped, or as hex
with `--key-encoding hex`.

Output paths default next to each input (`*.linked.csv`); the reject list
defaults to `rejects.csv`.

## Outputs

Instrument result, one row per accepted instrument record:

| participant_code | measurement_item | value |
|---|---|---|

Field result:

| participant_code | observation_category |
|---|---|

The `participant_code` column is the same value in both files for the same
participant, which is what lets the two be joined. Result files contain the
code and the business fields only -- never a registration number or master id.

Rejection list (internal only):

| source_file | line_number | source | registration_number | reason |
|---|---|---|---|---|

Reasons:

| reason | meaning |
|---|---|
| `registration_missing` | registration number is blank or has no crosswalk entry |
| `registration_ambiguous` | registration number maps to more than one master id |
| `purpose_not_approved` | the source is not approved for this participant and purpose |
| `malformed_row` | the row's cell count does not match the header |

`line_number` is the physical line in the source file where the row starts,
so a quoted field containing newlines does not shift later locations.

## Participant codes

A code is `P-` plus the first 16 hex digits, uppercased, of

```
HMAC-SHA256(key, "participant-linkage/v1" || 0x00 || purpose || 0x00 || master id)
```

The `0x00` separators stop a purpose and a master id from running together
into the same message. Consequences:

* the same key and purpose reproduce the same code on every re-export,
  so the two result files stay joinable across runs;
* the same person gets a different code under a different purpose;
* a code cannot be reversed without the key, but it is a pseudonym, not
  anonymisation -- anyone holding both the key and the crosswalk can
  reproduce it.

Treat the key as sensitive: rotating it changes every participant code and
breaks joins with earlier exports under the old key.

## The crosswalk

Delimited file (CSV or TSV; the extension picks, else the header decides)
with a header naming the source, the registration number, and the master id.
Accepted header names include `source` / `registration_number` / `master_id`
and the Chinese equivalents `来源` / `登记号` / `主编号`. Rows are keyed by
`(source, registration number)`, so an instrument number and a field number
that happen to be spelled the same do not collide.

The crosswalk is configuration: a blank or unknown-source row, or one that
is missing a field, stops the export instead of being skipped. Duplicate
`(source, registration)` pairs with different master ids are kept as
ambiguous and the affected records are rejected.

## The manifest

Approval is per `(purpose, master id)`. The canonical shape:

```json
{
  "participants": {
    "M-001": {"cohort-linkage": ["instrument", "field"]},
    "M-002": {"cohort-linkage": ["instrument"]}
  }
}
```

Approving a whole cohort at once:

```json
{
  "purposes": {
    "cohort-linkage": ["instrument", "field"],
    "instrument-only": ["instrument"]
  }
}
```

With per-participant overrides (an override replaces the purpose-wide set;
an empty list denies that participant):

```json
{
  "purposes": {
    "cohort-linkage": {
      "sources": ["instrument", "field"],
      "participants": {"M-002": ["instrument"], "M-003": []}
    }
  }
}
```

The export purpose must be listed in the manifest; an unknown or
differently-cased purpose stops the run rather than running with no
approvals. Unknown source names, a purpose that approves nothing, and a
purpose or participant listed twice with conflicting sets are errors.

## Behaviour worth knowing

* Both result files and the reject list are written only after both inputs
  have been read, so a failed run does not leave partial results. Files are
  replaced atomically.
* An output path equal to an input path, or two sources writing the same
  result file, is refused.
* Blank input lines are skipped and are not rejections.
* A key shorter than 16 bytes runs but prints a warning.

## Tests

The suite uses only the standard library:

```sh
python3 -m unittest discover -s tests -t .
```
