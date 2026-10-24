# Synthetic evaluation fixtures

**Everything here is invented.** No photographs exist for these cases. Every run, review and annotation is synthetic and marked `dataSource: "mock"` or `purpose: "tooling_test"`. Use them only to test the evaluator; they are never benchmark results.

Some files are deliberately unusable, to exercise error reporting:
- `predictions/broken.json` is malformed JSON.
- `predictions/unknown-case.json` refers to a case that isn't in the dataset.
- `predictions/syn-bed-001-older.json` is superseded by a later run.
- `reviews/syn-ambiguous-001.json` is an in-progress review.
- `syn-missing-001` has no run.
