# Retain I/O benchmark

Run after installing the repository dependencies:

```sh
npx vitest run --config scripts/benchmarks/vitest.config.ts
```

The opt-in harness uses synthetic transcripts, real private-file operations and mocked
HTTP/keyring responses. It reports read/write bytes, calls, fsyncs and elapsed time.
It does not measure native keyring or network latency. Instrumented timings vary with the filesystem and concurrent load.
Before you draw latency conclusions, compare operation counts.

Baseline: `34cb34ae41b643c96c167ac38324a19d1838ffc5`, Linux, Node 24.19.0.
To reproduce the baseline:

1. Copy `scripts/benchmarks/` into a checkout of that commit.
2. Install its dependencies.
3. Run the same command.

Each queue row has 1 KiB content and a distinct document. A flush sends at most 50
rows. Ordinary rows already have operation IDs. Legacy rows require durable IDs.
Each journal case appends 20 distinct short replies to an existing synthetic journal.
Identity preparation covers at most 50 requests and leaves room for the in-flight marker.
Near-capacity legacy queues fall back to durable per-row IDs as successful removals free space.

| Case | Metric | Before | After |
| --- | --- | ---: | ---: |
| Ordinary queue, 50 rows | Read calls / bytes | 302 / 9,092,800 | 152 / 4,605,020 |
| Ordinary queue, 50 rows | Rewrites / bytes | 149 / 4,429,160 | 99 / 2,933,750 |
| Ordinary queue, 50 rows | fsync calls | 299 | 199 |
| Legacy queue, 50 rows | Read calls / bytes | 302 / 8,879,000 | 153 / 4,751,285 |
| Legacy queue, 50 rows | Rewrites / bytes | 199 / 5,786,280 | 100 / 3,053,680 |
| Legacy queue, 50 rows | fsync calls | 399 | 201 |
| Ordinary queue, 100 rows, one batch | Read / rewrite bytes | 26,805,100 / 13,226,660 | 13,519,820 / 8,798,750 |
| Legacy queue, 100 rows, one batch | Read / rewrite bytes | 26,153,400 / 17,226,280 | 13,502,885 / 8,830,880 |
| 1 MiB journal, 20 appends | Read bytes | 21,006,845 | 1,310,720 |
| 7 MiB journal, 20 appends | Read bytes | 146,832,965 | 1,310,720 |

The 50-row ordinary queue reads 49.4% fewer bytes and rewrites 33.8% fewer bytes.
The 7 MiB journal reads 99.1% fewer bytes. Both journal runs still append the same
1,610 bytes. Full transcript reads for edit detection do not change. These journals
have short valid tail records. Long records or malformed suffixes can require multiple
64 KiB chunks, up to the whole bounded journal. Thus, 64 KiB is not an absolute read limit.

| Runtime call | Config reads before / after | Keyring reads before / after |
| --- | ---: | ---: |
| `managedSettings` | 2 / 1 | 3 / 2 |
| `managedReadScope` with session root | 3 / 1 | 5 / 3 |
| `harnessTransport` | 1 / 1 | 3 / 2 |

Twenty sequential append-capability checks on one client still make 21 HTTP requests:
one version request and 20 bank-config requests. Their keyring reads drop from 42 to
21. Twenty fresh clients still make 40 HTTP requests, with keyring reads dropping
from 140 to 80. Each call checks bank configuration again. Each authorization boundary refreshes credentials.
The change adds no process-lifetime cache for credentials or bank configuration.

