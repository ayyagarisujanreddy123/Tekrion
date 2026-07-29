# Performance smoke measurement

This document publishes a reproducible local smoke measurement, not a general performance guarantee.

## Result

- Measured: 2026-07-21T07:20:03.766Z
- Measured source commit: `3ceb53a89f2d898917a447554096394be1608dcf`
- Command: `npm run benchmark`
- Samples: 10 warmups, then 100 measured requests per route
- Machine: Intel Core i7-9750H, macOS 25.5.0, x64
- Runtime: Node.js v22.20.0
- Fixture SHA-256: `a48eb11e0f9d8862dc401e68ce421e6417365163c286287f24867f38ab717f1f`

| Route and metric               | p50      | p95      |
| ------------------------------ | -------- | -------- |
| Direct upstream TTFB           | 0.711 ms | 1.403 ms |
| Recorded proxy TTFB            | 4.869 ms | 7.434 ms |
| Direct upstream total          | 0.787 ms | 1.592 ms |
| Recorded proxy total           | 4.965 ms | 7.569 ms |
| Cockpit initial document TTFB  | 0.920 ms | 1.191 ms |
| Cockpit initial document total | 0.996 ms | 1.327 ms |

The p95 recorded-minus-direct delta was 6.031 ms to first byte and 5.977 ms total. The packaged cockpit had three production assets totaling 350,226 raw bytes and 99,525 bytes when each asset was gzipped. Source maps are excluded from that payload count.

## Method and limits

The benchmark starts a loopback HTTP upstream, a fresh Tekrion daemon and evidence store, and the packaged cockpit. It alternates direct and recorded non-streaming Responses requests with a small deterministic JSON body, consumes every response, and requests the cockpit's initial HTML document once per sample. It records wall-clock durations with Node's monotonic performance clock.

This does not measure Internet latency, large bodies, SSE streams, concurrency, peak memory, browser parsing, rendering, frame time, or interaction latency. Loopback requests are much shorter than the 500 ms scenario used by the design's percentage-overhead target, so no percentage claim is made. Results vary by machine and background load; run `npm run benchmark` on each claimed release platform before publishing broader numbers.
