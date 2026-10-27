# services/

Backend components that do not belong in the Next.js app. Python services are not part of the pnpm workspace.

- [`vision/`](vision/README.md): local SigLIP 2 image embeddings and cosine similarity for the visual shortlist (PyTorch + Hugging Face Transformers). A command-line component called by `pnpm shortlist:images`; not a server.
