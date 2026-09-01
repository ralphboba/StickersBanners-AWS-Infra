# Linh's requirements & answers (source of truth)

Linh is the author of the legacy program (SBBotExpress + SBImageProcessor) and
the domain authority. These are his own answers, quoted, plus what still needs
confirming. Treat this as the spec the new system must match.

## Routing (facility assignment)

> **"Zip code check only applies to nv/ca cause nv ships to some zip codes in
> ca. The rest of the production ships by state."**

- **NV / CA** → decided by **ZIP** (NV ships to certain CA-destination ZIPs; those
  take precedence, else CA). Implemented from legacy `zip.xlsx`
  (`src/shared/zipRouting.mjs`).
- **GA / NJ / TX / NV** → decided **by shipping state**. Linh gave the exact
  lists (now implemented in `src/shared/routing.mjs`):
  - **GA**: AL FL GA IN KY MI MS NC SC TN WI OH WV VA
  - **NJ**: CT DC DE MA ME NH NJ NY RI VT MD PA
  - **TX**: AR CO IL IA KS LA MO ND NE NM OK SD TX WY MN
  - **NV**: WA OR NV AZ UT ID MT
  Decision order: NV_ZIPS → CA_ZIPS → state lists → UNROUTED.

## Credentials (Linh confirmed)

- **FTP** (GA/NJ/TX/NV): "still the same, should all be in the python code" —
  host `64.57.252.252`, user `branch`.
- **CA Google Drive folder ID**: "still the same" — `0AAv6uDYl6AfsUk9PVA`
  (a **Shared Drive**, needs `supportsAllDrives=True`).
- **Zendesk** (main customer channel — sends the proof-ready email):
  subdomain `stickersbanners`, email `linh@stickersbanners.com`, API token provided.
- **Google service account**: JSON file provided directly (gitignored, seeded to SSM).
- **OrderDesk**: store id `784`, API key provided.
- NOTE: all pasted keys were exposed in chat → **rotate before real go-live.**

## Behaviour Linh specified

- **Artwork files**: "read only permission for proof files only, **there's no
  downloading any files for the artwork** … everyone has direct access to the
  folder." → We do NOT have a sanctioned artwork-download path from Linh; revisit
  how AWS pulls customer artwork. (We had been fetching from a public S3 upload
  bucket — confirm this is acceptable.)
- **Completed**: "after a tracking number is assigned or cx pick up, **handled by
  production**. The bot only sends orders to production's folder." → Our pipeline
  correctly ends at delivery to the facility (`pickup_*`); production owns the
  rest. Do NOT build a "completed" transition ourselves.
- **Proofs / approve-reject**: "I don't understand the approve/reject mechanism.
  **Cx just reaches out via email if they want to revise. I don't want them to
  have the option to upload files** (they abuse it by uploading 5-6 files for
  reproofing)." → Do NOT add customer-facing approve/reject or file upload. Proof
  revisions happen over email. The staff dashboard's "Send to production" is a
  staff action, which is fine.
- **Workflow**: "the program pings orderdesk for a job pool → filter and clean it
  → send processed job data to python → python process → done."
- **OrderDesk push**: no outbound webhook available → intake is by **polling**
  the QTS folder (matches legacy).
- **Google Chat alerts**: turned OFF per Kai — staff track everything in the
  dashboard; Zendesk proof email is the only external notification.

## Still to confirm with Linh

1. Full GA/NJ/TX/NV state→facility lists (or approve deriving them from real orders).
2. How AWS should pull customer artwork (Linh says no artwork download exists).
3. Hardware SKU list (legacy filtered hardware-only line items via a Redis dict;
   Linh: "hardware sku just comes from the excel sheet for hardware").
4. "Grommet with Bravo Tab (TOP only)" — grommets on all 4 sides or top only?
