# Phase 0.11 — SDK Sandbox 100x measurement
**Run**: 2026-05-18T01:24:41.827Z
**Wall time**: 248.4 s (avg 2484 ms/call)
**Successes**: 100 / 100
**Failures**: 0
**Total cost**: $0.4922 (avg $0.00492/call)
## Memory / handles (post-call snapshot)
| metric | min | p50 | p95 | max | first | last | slope/call |
|---|---|---|---|---|---|---|---|
| rss MB | 100.6 | 106.2 | 108.9 | 128.5 | 128.3 | 109.0 | 0.027 |
| heapUsed MB | 23.8 | 26.7 | 28.6 | 29.1 | 27.0 | 29.1 | 0.042 |
| handles | 1 | 1 | 1 | 1 | 1 | 1 | 0.000 |
| duration ms | 1922 | 2311 | 3637 | 9487 | 1957 | 2553 | -5.099 |
## Cache pattern (1H + 5m prompt cache)
| metric | min | p50 | max | first | last |
|---|---|---|---|---|---|
| cache_read tokens | 27088 | 40804 | 40804 | 27088 | 40804 |
| cache_create tokens | 0 | 0 | 13716 | 13716 | 0 |
## Go criteria (Phase 0.11)
- Monotonic rss growth: ✅ (slope 0.027 MB/call, threshold <0.5)
- Monotonic heap growth: ✅ (slope 0.042 MB/call, threshold <0.3)
- Handle growth: ✅ (slope 0.000 handles/call)
- Failure rate: ✅ (0 / 100)
Raw samples: `measure-samples.jsonl`