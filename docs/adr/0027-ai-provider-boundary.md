# ADR-0027: The AI Provider Adapter and Its Network Boundary

## Status

Accepted

## Context

Phase 1 is deterministic and offline: `palee next`, `plan`, `review`, `validate`, `adopt`, `roadmap --from` and `migrate` open no sockets. Phase 2 needs a provider, and the first network call shipped in the 1.0.0 release build-up (#293 stored the endpoint and credential; #297 added the adapter and `config test-connection`; #316/#317 hardened where the key may live on Windows). This ADR records the boundary decisions, because "the first code in the product that can talk to the network" is exactly the kind of decision that gets made once and then defended forever.

The design premise is "bring your own OpenAI-compatible endpoint" — any provider, including a LAN one. An allowlist would break that, and the value being validated is the user's own config, not an attacker's request. What the boundary has to honour is the *surprising target*: a base URL pointing at link-local space reaches the cloud metadata service, and nothing legitimate lives at the unspecified or multicast addresses.

## Decision

### The adapter is built around an injected `Transport`

```typescript
export type Transport = (url: string, init: RequestInit) => Promise<Response>;
```

That seam "is the reason the request shape is knowable at all: the unit tests assert the exact URL, headers, body keys, retry count and signal, none of which a `fetch`-calling test could observe." The default transport is the platform `fetch`; tests inject a recorder.

### `config test-connection` is the only command that reaches the network — structurally

`test/ai-network-boundary.test.ts` fails if a second socket site appears anywhere in `src/`. The guarantee is enforced by a test that scans the source, not by a convention — the one property of the offline core that everything else in this backfill depends on.

### Reserved address space is refused outright, over https included

`isReservedHost` decides on the canonical hextet prefixes Node's serializer produces, measured rather than assumed:

- **The refused IPv6 prefixes are measured against what Node serializes**: link-local `fe80::/10` spanning `fe80` through `febf` — `/^fe[89ab]/`, not merely the `fe80` literal (the first version matched the literal, so `fe90::`, `fea1::` and `febf::` slipped through). The same test also refuses unique-local (`fc`/`fd`, `/^f[cd]/`) and multicast (`ff`, `/^ff/`); `fec0` (the retired site-local range) stays outside, because a prefix that matches none of the three tests is simply not refused.
- **An IPv4-mapped literal is unwrapped and judged by the IPv4 rules** — `embeddedIPv4` decodes the two hextets, because `https://[::ffff:169.254.169.254]/` reaches `URL.hostname` as `[::ffff:a9fe:a9fe]`, not as a dotted quad. "A rule written against the spelling a caller types would never fire."
- **`::1` is exempted first**, so it is not refused as a `0.x` quad — permitting loopback is what makes a local provider on an IPv6 stack usable over http.
- **IPv4**: `0.x`, `169.254.x.x` (the metadata service), `100.100.100.200` (Alibaba Cloud serves its metadata at a routable-looking address, so the same "surprising metadata target" rationale refuses it), and `>= 224` (multicast and reserved). RFC 1918 and CGNAT stay **permitted on purpose**: a provider on the LAN is a legitimate bring-your-own-endpoint, exactly like a loopback one.
- **Named, not just numbered**: the RFC 6762 `.internal` suffix is refused, because `metadata.google.internal` is a metadata endpoint with no reserved address.
- Address shape decides, never the start of a DNS name: `169.254.example.com` is a hostname someone owns; `169.254.169.254` is the metadata service.

### Plain HTTP is allowed only for loopback

The request carries a bearer token, so `http:` to anything else is refused with the reason stated. Loopback is exempt because that is the only place the token cannot leave the machine.

### The endpoint may not carry credentials, query, or fragment

A base URL embedding a username or password is refused (the credential is `set-api-key`'s job), and so are query and fragment — the appends its own path, and a stored `?key=...` would leak into every request line.

### Redirects are refused rather than followed

A redirect would re-send the credential to a host nobody approved.

### The read bound is measured while streaming

`MAX_RESPONSE_BYTES` is 256 KiB, and the body is read chunk by chunk with `reader.cancel()` once the running total passes it — not buffered and checked after. Proof the old version was not merely late: an endless 64 KiB-per-pull stream under `--max-old-space-size=128` died with "Committing semi space failed." The collected chunks are decoded once at the end, which is why a three-byte character split across two chunks survives. The buffered path remains only for a null body (synthetic or already-consumed responses).

### The credential never goes through argv

`set-api-key` reads from `--from-env <VAR>`, a pipe, or an interactive prompt, in that order; a positional is refused with exit 2, because `argv` is readable by every other process (`ps`, `/proc/<pid>/cmdline`) and lands in shell history. An empty pipe or an unset variable is refused, so no blank credential is ever stored. `config show` prints `••••••••` and the test asserts no *part* of the key appears in stdout, including a suffix. The file is written `0600`/`0700` on POSIX — the mode is set when `saveConfig` opens the temp file, before any byte of payload exists — and `PALEE_API_KEY` in the environment outranks the stored key, for anyone who would rather never write it to disk.

### Windows: the refusal is "location, not ACL"

On Windows the POSIX mode is a no-op; NTFS access is inherited from the config directory's ACL. `set-api-key` refuses to persist when the resolved config directory is outside the user's profile roots, through a pure `isConfigDirStorableForKey` using `path.win32.relative` — it folds case, resists the `bob`/`bobby` prefix trap, and is unit-testable on fixture paths on any OS. **The recorded trade-offs**: no native dependency and no `icacls` spawn, so it cannot read the real ACL; a OneDrive-synced `%USERPROFILE%` still passes (it *is* the profile); and `PALEE_ALLOW_INSECURE_CONFIG_DIR=1` remains the documented override for a directory secured by other means. The deferral itself was a scope decision — "enumerating and validating NTFS ACLs is a platform-specific hardening feature in its own right" — tracked in #316 rather than expanded into the credential PR.

## Consequences

### Positive

- The offline core's guarantee is test-enforced; a second socket site fails CI.
- The SSRF surface is closed against the targets that matter (metadata services, multicast, unspecified) without breaking bring-your-own-endpoint, including LAN and loopback providers.
- The request shape is observable in tests, which is how the redaction ordering and retry behaviour got pinned.
- A mistyped or planted endpoint cannot turn `test-connection` into a probe of the host's own network.

### Negative / Tradeoffs

- **RFC 1918 and CGNAT are permitted**, so a base URL on the corporate LAN is accepted by design. The threat model is "surprising metadata target," not "any private address" — stated in the code so the scope of the guarantee is explicit.
- **The Windows guard checks location, not the actual ACL.** A share inside the profile is theoretically possible; the practical cases (share, synced folder, non-profile clone) are caught, and the residual is recorded with its override.
- **`test-connection` sends a real prompt to a real endpoint.** It is the one command that can leak the configured endpoint's existence to that endpoint; everything else stays offline.

## Alternatives Considered

1. **An allowlist of known provider hosts.**
   - *Why Rejected*: the spec's premise is "bring your own OpenAI-compatible endpoint." An allowlist breaks local and self-hosted providers to close a threat (a planted config value) the user already controls.
2. **Follow redirects and re-validate at each hop.**
   - *Why Rejected*: the credential would still be sent to the first hop, and the chain of approvals is unbounded. Refusing is the only shape where "the host nobody approved" never receives anything.
3. **Buffer the response and check the size after.**
   - *Why Rejected*: an endless stream OOMs before the check runs — measured. The bound has to be enforced *during* the read, with cancellation.
4. **Accept the key as a positional argument.**
   - *Why Rejected*: `argv` is readable by every other process and lands in shell history. stdin/env/prompt only.
5. **Validate NTFS ACLs natively on Windows.**
   - *Why Rejected (for now)*: no dependency-free way to read an ACL without spawning `icacls` per write, and a false refusal on a legitimately-secured directory would be worse than the gap. Recorded in #316 as its own feature with its constraints written down.
