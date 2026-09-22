# `/AWS-TEST` audit — 2026-09-22

The check the go-live runbook names as stage 2's completion bar:

> The generated TIFFs against Linh's for the same order — byte-identical is the
> bar, and that validates the whole image pipeline in one comparison.

It had never been run. The 2026-09-13 and 2026-09-19 windows put 23 orders'
print files under `/AWS-TEST` on the facility FTP and nobody had opened them.

## Result

**Our print files are byte-identical to Linh's.** Three orders could be compared
directly; all three match, file for file, on SHA-256 of the full contents:

| order | file | bytes | sha256 (first 16) |
|---|---|---|---|
| S61803 | `S61803-1-1 .tif` | 11,467,000 | `73f96137b7d1caa2` |
| S61828 | `S61828-1-1 PPTO.tif` | 42,211,798 | `896b9e434028e893` |
| S61831 | `S61831-1-1 .tif` | 6,153,252 | `71424ad233219cb4` |
| S61831 | `570883925.jpg` (invoice proof) | 446,852 | `733b7025058009fd` |

S61828 carries a Pole Pocket Top Only, so the finishing path is inside the
match, not just the plain resize. The invoice proof jpg matches too, which
covers the proof service's output as well.

### What the match does NOT cover

The three matched orders are **jpg, png and png**. No PDF-sourced order could be
compared, so the PDF rasterisation path — the one `pdf_render_dpi` now touches —
has no byte-identical evidence in either direction. That is the largest
remaining gap in the image pipeline.

Finishing families still unmatched: PPTB, PPBO, RET, GO, CO, HO. (CO appears in
`/AWS-TEST` on S59963, S59966, S59969 and S61772, but those orders are not in
Linh's folders any more, so there is nothing to compare them against.)

## Structure

23 order folders, 126 files, **0 discrepancies**. Every order has exactly one
TIFF per print item (matching `items` in its DynamoDB record) and exactly one
invoice jpg per `renameDict` entry. No zero-byte files, no unexpected file
types, no unreadable directories.

```
/AWS-TEST/GA   S59969 S59971 S59980 S59984 S61775 S61783 S61791 S61794
               S61803 S61828 S61831
/AWS-TEST/NJ   S59963 S59966 S61789 S61848
/AWS-TEST/NV   S59974 S61799 S61847
/AWS-TEST/TX   S59989 S61772 S61835 S61850 S61851
/AWS-TEST/Proof  42 invoice jpgs
```

## Why only three orders could be compared

The facilities do not all keep order folders. Listing the real roots:

| facility | shape |
|---|---|
| `/GA` | 3,171 order folders, kept. Ours are still there to compare against. |
| `/TX` | 3 entries — `Trash`, `09.22`, one order. Production sweeps orders into dated batch folders. |
| `/NJ` | 8 entries — `PROCESSED`, `9.22 Tuesday`, dated folders. Same pattern. |
| `/NV` | 2,376 folders, but a direct read of `/NV/S61847` is a 550. |

So for TX, NJ and NV the reference output no longer exists as a per-order
folder. This is worth knowing independently of the audit: **a comparison against
those three facilities has to be made within a day or two of the transfer**, or
the evidence is gone.

## How it was run

`src/services/ftp/ftp_inspect.py` on the `sb-dev-ftp` task definition, which
neuters every mutating ftputil method before touching a path. Three runs: list
`/AWS-TEST` at depth 3; list the same orders under the real facility roots; then
fetch the matched pairs to `s3://sb-dev-processed-.../_pairs/` for hashing.

No IAM change was needed — the ECS task role already has `s3:PutObject` on the
processed bucket. The earlier note claiming a missing permission was about a
different bucket and was wrong.

ECS tasks must run in a **public** subnet with `assignPublicIp=ENABLED`; dev has
`natGateways: 0`, so a private subnet cannot pull the image.
