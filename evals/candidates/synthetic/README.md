# Synthetic candidate manifest

`syn-bed-001.json` is **invented**: no listing, supplier, price or URL in it is real. It uses reserved example domains (`*.example.com`) and `dataSource: "mock"`, and is paired with the synthetic run record `evals/image-understanding/synthetic/predictions/syn-bed-001.json`.

It exists to show the manifest format and to exercise `pnpm source:candidates` without real data:

```sh
pnpm source:candidates --case syn-bed-001 --synthetic \
  --predictions evals/image-understanding/synthetic/predictions \
  --candidates evals/candidates/synthetic --run
```

Genuine manifests belong in the git-ignored `evals/local/candidates/`. Do not add real Alibaba.com listings or supplier data to shared files.
