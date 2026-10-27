# Synthetic discovery fixture (not real data)

`syn-bed-001/disc-2026-10-27T00-00-00Z-000000/` is a hand-made automated-discovery run for the synthetic case `syn-bed-001`: a `run.json` journal and two provider snapshots (image and keyword) in the shape returned by the Apify Actor `scrapewise/alibaba-com-scraper`.

- Every product, supplier, id and URL is invented. URLs use reserved example domains (`*.alibaba.example`), titles are marked `[SYNTHETIC]`, and the run is `dataSource: "mock"`.
- No provider was called to make it. The rows deliberately include a duplicate, a real-Alibaba URL (rejected in synthetic data), an id/URL mismatch, an empty title, an error row and a non-object row.

Replay it offline (no network):

```sh
pnpm discover:marketplace --case syn-bed-001 --predictions evals/image-understanding/synthetic/predictions \
  --replay evals/discovery/synthetic/syn-bed-001/disc-2026-10-27T00-00-00Z-000000
```
