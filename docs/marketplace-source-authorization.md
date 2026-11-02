# Marketplace source authorization

Access decision for automated Alibaba.com candidate discovery. Written for P1-008 on 2026-10-27. It is a short, evidence-based record, not market research.

**Decision: no source is authorized for live use. Automated discovery stays blocked, and the operator-assisted web intake is the working path.**

The project rule (`AGENTS.md`) is that Alibaba discovery may only use a confirmed, authorized integration: an official API or an approved partner, with no scraping. The code enforces this in `discovery/authorization.ts`. A token, an Actor subscription or `--data-use-reviewed` never establishes permission on its own.

## A. Alibaba.com Open Platform (official)

| | |
|---|---|
| Provider | Alibaba.com Open Platform, https://openapi.alibaba.com/doc/doc.htm |
| Status | Official |
| Documented capabilities | Not confirmed. The documentation portal renders client-side and returned only "loading…" when fetched. Secondary sources describe seller/ISV integrations (an App Key and App Secret, then OAuth, then permissions for product, order, inventory and inquiry management), not buyer-side product search. |
| Search by image / keyword product search | No documented buyer-side operation found. A 1688.com "search by image" API is described elsewhere, but 1688 is a different marketplace and the method name was unverified. |
| Eligibility | ISV application with a registered Alibaba.com account, reviewed by Alibaba.com (older GGS marketplace rules; may be outdated) |
| Credentials | App Key and App Secret, with OAuth per seller |
| Image transfer, caching and display terms | Unknown |
| Costs and limits | Unknown |
| Unresolved | Whether any buyer-sourcing search API exists, who is eligible, and its retention and display terms |
| Live use | **Blocked:** not implemented, no documented operation, no access |

**Not to be confused with:** Alibaba Cloud Image Search searches a catalogue you upload yourself. It does not search Alibaba.com listings.

## B. Approved partner or licensed marketplace-data source

| | |
|---|---|
| Provider | None identified |
| Status | — |
| Finding | No provider with documented rights to search and reuse Alibaba.com listing data for this use was found. Public scraper APIs (including Apify Actors covering 1688, Alibaba and AliExpress) document capabilities, not rights. |
| Live use | **Blocked:** nothing to enable |

## C. Existing adapter: Apify Actor `scrapewise/alibaba-com-scraper` (P1-004)

| | |
|---|---|
| Status | Third-party scraper on Apify; not an official Alibaba.com API |
| Documented capabilities | Image, keyword and URL search; listing URL, images, price, MOQ and supplier link (see [automated-marketplace-discovery.md](automated-marketplace-discovery.md)) |
| Credentials | `APIFY_TOKEN` |
| Permission status | **None.** There is no agreement with Alibaba.com or the Actor's author. A secondary source says Alibaba.com's Terms of Use prohibit systematic retrieval without written permission; the primary terms page was unreadable. |
| Acquisition method | Scraping, with the Actor's own fallback to fresh and residential IPs when refused |
| Image transfer | Image search sends the reference photo to the provider (a user-hosted URL, or a temporary upload to the user's Apify storage; `imageFile` handling is undocumented) |
| Limits and costs | Our caps: up to 50 results and $10 per invocation, refused if the published-price estimate exceeds the cap. Apify bills per result and event (see the P1-004 doc). |
| Unresolved | Alibaba.com's written permission; Apify's and the Actor's terms; whether relying on the Actor's IP fallback is acceptable |
| Live use | **Blocked by policy.** The scraping acquisition method is prohibited by `AGENTS.md`, so the eligibility check fails closed whatever is configured. Offline replay of synthetic fixtures still works. |

## What would change the decision

1. A written confirmation, held by the developer, of an official API or approved partner that permits buyer-side product and image search, with its retention and display terms.
2. An adapter for that source, registered in `discovery/authorization.ts` with its real access basis.
3. An access record in `evals/local/marketplace-access.json` (git-ignored) naming:
   - the agreement;
   - who reviewed it and when;
   - the permitted modes and whether image transfer is approved;
   - per-run caps;
   - `liveEnabled: true`.

Changing the project rules to permit a scraper is a human decision. The code never does it.
