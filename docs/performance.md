# Performance smoke measurement

This document publishes a reproducible local smoke measurement, not a general performance guarantee.

## Result

- Measured: 2026-08-08T03:48:34.003Z
- Measured source commit: `d745da862f03dd4d3be7766480a0004b4ab2ff84`
- Command: `npm run benchmark`
- Samples: 10 warmups, then 100 measured requests per route
- Machine: Intel Core i7-9750H, macOS 25.5.0, x64
- Runtime: Node.js v22.20.0
- Fixture SHA-256: `641456124a454d129db426912679eeb4a63e0fd6e2063dea40072eb5189a464d`

| Route and metric               | p50      | p95      |
| ------------------------------ | -------- | -------- |
| Direct upstream TTFB           | 0.714 ms | 1.060 ms |
| Recorded proxy TTFB            | 5.733 ms | 9.366 ms |
| Direct upstream total          | 0.791 ms | 1.179 ms |
| Recorded proxy total           | 5.837 ms | 9.463 ms |
| Cockpit initial document TTFB  | 0.969 ms | 1.273 ms |
| Cockpit initial document total | 1.050 ms | 1.430 ms |

The p95 recorded-minus-direct delta was 8.306 ms to first byte and 8.284 ms total. The packaged cockpit had three production assets totaling 375,658 raw bytes and 104,892 bytes when each asset was gzipped. Source maps are excluded from that payload count.

## Method and limits

The benchmark starts a loopback HTTP upstream, a fresh Tekrion daemon and evidence store, and the packaged cockpit. It alternates direct and recorded non-streaming Responses requests with a small deterministic JSON body, consumes every response, and requests the cockpit's initial HTML document once per sample. It records wall-clock durations with Node's monotonic performance clock.

This does not measure Internet latency, large bodies, SSE streams, concurrency, peak memory, browser parsing, rendering, frame time, or interaction latency. Loopback requests are much shorter than the 500 ms scenario used by the design's percentage-overhead target, so no percentage claim is made. Results vary by machine and background load; run `npm run benchmark` on each claimed release platform before publishing broader numbers.
