import type { SourcingEntry } from "@/lib/sourcing/orchestration/assemble";
import { formatDate, formatMoq, formatPrice, humanize } from "@/lib/sourcing/ui/labels";
import { DataRow, ExternalLink } from "./primitives";

/**
 * Listing and supplier facts exactly as recorded from the marketplace.
 * Everything here is seller- or marketplace-reported and unverified by this
 * application; badges are shown as claims with their source.
 */
export function ProductDetails({ entry }: { entry: SourcingEntry }) {
  const p = entry.product;
  const s = entry.supplier;
  return (
    <div className="space-y-4">
      <p className="rounded-lg bg-sand px-3 py-2 text-xs text-muted">
        Marketplace-reported information, recorded as listed. It has not been independently verified, and visual similarity does not establish who made a product.
      </p>
      <dl>
        <DataRow label="Listing">
          <ExternalLink href={entry.listingUrl}>{entry.title}</ExternalLink>
        </DataRow>
        <DataRow label="Product ID">{entry.marketplaceProductId ?? "Not provided"}</DataRow>
        <DataRow label="Listed price">{formatPrice(p.price)}</DataRow>
        {p.priceTiers?.length ? (
          <DataRow label="Price tiers">
            <ul className="space-y-0.5">
              {p.priceTiers.map((t, i) => (
                <li key={i}>
                  {t.minQuantity}
                  {t.maxQuantity ? `–${t.maxQuantity}` : "+"}: {t.currency ? `${t.currency} ` : ""}
                  {t.price.toLocaleString("en-GB")}
                </li>
              ))}
            </ul>
          </DataRow>
        ) : null}
        <DataRow label="Minimum order">{formatMoq(p.minimumOrder)}</DataRow>
        <DataRow label="Supplier">{s ? s.name : "Not provided"}</DataRow>
        {s ? (
          <>
            <DataRow label="Location">{[s.location, s.countryCode].filter(Boolean).join(" · ") || "Not provided"}</DataRow>
            <DataRow label="Supplier profile">{s.profileUrl ? <ExternalLink href={s.profileUrl}>Open profile</ExternalLink> : "Not available in listing data"}</DataRow>
            <DataRow label="Years on platform">{s.platformTenureYears !== null ? `${s.platformTenureYears} (as reported)` : "Not provided"}</DataRow>
            <DataRow label="Marketplace claims">
              {s.marketplaceClaims.length ? s.marketplaceClaims.join("; ") : "None recorded (unknown, not “unverified”)"}
            </DataRow>
          </>
        ) : null}
      </dl>
      {p.attributes ? (
        <details className="group rounded-lg border border-line bg-paper">
          <summary className="cursor-pointer list-none px-3 py-2.5 text-sm font-medium text-ink marker:hidden">
            Seller-reported attributes ({Object.keys(p.attributes).length}) <span className="text-muted">— unverified</span>
          </summary>
          <dl className="border-t border-line px-3 py-1">
            {Object.entries(p.attributes).map(([k, v]) => (
              <DataRow key={k} label={k}>
                {v}
              </DataRow>
            ))}
          </dl>
        </details>
      ) : null}
      <details className="rounded-lg border border-line bg-paper">
        <summary className="cursor-pointer list-none px-3 py-2.5 text-sm font-medium text-ink">Acquisition and provenance</summary>
        <dl className="border-t border-line px-3 py-1">
          <DataRow label="Acquisition">{humanize(entry.provenance.acquisitionMethod)}</DataRow>
          <DataRow label="Provider">{entry.provenance.providerId ? `${entry.provenance.providerId} (${entry.provenance.providerAccess?.replace(/_/g, " ")})` : "None — found by a person on Alibaba.com"}</DataRow>
          <DataRow label="Captured">{formatDate(entry.provenance.capturedAt)}</DataRow>
          {p.missingFields.length ? <DataRow label="Not in listing data">{p.missingFields.map(humanize).join(", ")}</DataRow> : null}
        </dl>
      </details>
    </div>
  );
}
