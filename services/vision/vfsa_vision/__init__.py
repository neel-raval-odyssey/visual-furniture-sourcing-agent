"""Local SigLIP 2 image embeddings and cosine-similarity shortlisting.

Bounded CLI component called by the TypeScript shortlist command. It reads
only the image files named in a validated request, never fetches URLs, and
never downloads model weights except through the explicit `download` command.
"""

PROTOCOL = "vfsa-image-similarity"
PROTOCOL_VERSION = 1
DEFAULT_MODEL_ID = "google/siglip2-base-patch16-384"
