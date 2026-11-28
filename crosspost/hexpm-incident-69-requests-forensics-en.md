---
title: "Thirteen Minutes With No Log: Reconstructing the Hex.pm Compromise From 69 Requests"
subtitle: "The attacker got a 500 back every single time. What remained was a handful of files on six web servers and a table matching each file to a request timestamp. Inside the methodology that let the vendor prove what did not happen — and the four things it still cannot rule out — plus the release status of the ecosystem patches as of November 28."
canonical_url: "https://dohyeontech.github.io/posts/hexpm-incident-69-requests-forensics/"
cover_image: "https://dohyeontech.github.io/assets/images/thumb_hexpm_incident_69_requests_en.png"
tags: [security, elixir, devops, forensics]
source_ko: "https://dohyeontech.github.io/posts/hexpm-incident-69-requests-forensics/"
---

*This is the English adaptation of the original Korean analysis at [dohyeontech.github.io](https://dohyeontech.github.io/posts/hexpm-incident-69-requests-forensics/).*

At 18:16:00 UTC on 23 November 2026, an exception landed in hex.pm's Sentry instance. The last malicious request reached a server at 18:29:33 — thirteen minutes and thirty-three seconds later. In between, 69 requests arrived and files appeared on six web servers. The first file was written **3 milliseconds** after one of those requests. By 18:30–18:31, every web, worker and job server had been replaced with a patched build.

Every response the attacker received was a 500. Success: 500. Failure: 500. That is why they sent 69 of them. No account was created, no file was planted as persistence, no shell was held open. What remained was a handful of files on disk and a table pairing each one to a request timestamp.

The exploit mechanics and the patch code were covered in an [earlier piece](/posts/hexpm-struct-rce-cve-2026-129514/). This one is about everything after the attack stopped: **what the vendor compared, how, what each comparison proves, and what it cannot.** And, because a CVE record and a package release are different events, where each ecosystem fix actually stands as of November 28.

## 1. Scale, and the clock the vendor reported

hex.pm is the default registry for Elixir, Erlang and Gleam. As of November 28, its public page reports 27,325 packages, 288,312 versions, 9,726,182 downloads in the previous day, and 16,383,604,483 all-time.

The disclosure says traffic was blocked and a fix deployed "within 20 minutes." The logs support that, if you measure from the right place:

| Interval | Duration |
| :--- | :--- |
| First request of any kind (18:14:21) → full block (18:33:48) | **19 min 27 s** |
| First exploit request (18:16:00) → all servers patched (18:31) | **15 min** |
| First exploit request → first server-side response (18:23:55) | **7 min 55 s** |

That middle number is the one to sit with. **Seven minutes and fifty-five seconds passed between the first exception and the first action on a server.** Not because nobody was watching, but because the signal arrived in an error tracker rather than in anything that was watching for attacks. The exploit request is *designed* to raise an exception — the fake struct's `fetch/2` does not exist — so Sentry recorded one error per request. That was the detection.

The firewall rule landed at 18:27. It took effect between 18:30 and 18:33. Rules that exist and rules that are enforced are different states, and the gap between them is where requests kept arriving.

The fix commit, `379b0a2`, has a commit timestamp of **18:26:41**. That is 10 min 41 s after the first exploit and **4 minutes 19 seconds** before every server was running it. Root cause, code change, regression tests, and a full fleet replacement inside a thirteen-minute attack window. That is the most impressive number in the incident.

## 2. Why the commands were not in any log

The sentence "we cannot rule out that the attacker read the database" is not the interesting part. The interesting part is that **there was no mechanism that could have answered it.**

**Commands ran outside the application's logging path.** Execution happens through DBConnection's `:log` callback, which exists to log queries. The thing that would record the execution *is* the execution. It cannot log itself.

**The `Inspect` implementation swallows exceptions.** The chain runs inside `Inspect.Algebra`'s rescue. A successful command produces no output in the response; the request ends as an ordinary 500 from `Plug.MethodOverride`. Blind execution — which is also why it was retried 69 times.

**Database reads are not audited.** Writes reach the audit log. A `SELECT` against `members`, `api_keys`, `sessions` or `audit_logs` leaves nothing behind. This is exactly why the exposure boundary is stated as "cannot rule out" rather than "was breached."

**Environment variable reads and shell output share the same hole.** `DATABASE_URL`, storage credentials and signing keys are read from process memory. The stdout of a shell command goes nowhere. If data left the building, the only trace would be network flow — and in thirteen minutes, that was not a lot of flow.

The conclusion is unsentimental: **absence from logs is not absence of events.** The reason the investigation went as far as snapshot diffs, storage checksums and S3 access-log correlation is that the empty parts of the log had to be filled with a different kind of evidence.

## 3. Five comparisons, and the holes in each

### 3.1 The request boundary

Load balancer logs for both attacker addresses, from first request to 19:05: first exploit at 18:16:00, last exploit to reach a server at 18:29:33, nothing successful afterwards, 69 requests total. This fixes the time boundary: anything after 18:29:33 is unrelated to this vulnerability. Anything before 18:14:21 is outside the range — so a separate review covered hex.pm, repo.hex.pm, builds.hex.pm and hexdocs.pm from November 19 onward. Both addresses had been repeatedly downloading hex.pm's own dependencies. **The attacker was building a local copy to test against, at least four days early.**

### 3.2 Execution evidence: files against timestamps

In a blind execution, the way to prove a command ran is a side effect. Files served that purpose. Matching each created file to an exploit request timestamp produced the first at 3 ms after a request at 18:16:46, and identified six web servers.

The six is the detail worth keeping. A restart at 18:28 brought up three servers that were **still on the vulnerable build**. Deployment was in progress; the restart pulled the old image back. Half of the compromised fleet joined mid-incident because a rollout was not atomic. "We patched everything" and "everything is running the patch" are different claims, and a restart can invalidate the second one.

### 3.3 No writes: full comparison against an 18:13:59 snapshot

They restored a copy of the database from 18:13:59 — twenty-two seconds before the attacker's first request of any kind — and compared every row of every table. Every difference was explained by an audit-log entry from another address, a background job, or the team's own response actions.

The report states its own limit: **a row that was changed and then changed back, or one overwritten by a later legitimate change, would not appear.** A snapshot diff proves something about final state, not about state transitions. If you need transitions, you need WAL, logical replication, or per-table trigger auditing.

### 3.4 Package integrity: 23, 62, 186

The 23 releases published during the incident all matched a publish or stage entry in the audit log; no older release changed; the 62 package files and 186 registry files written after 18:00 matched their database checksums.

The hole: **documentation archives have no stored checksum to compare against.** Checksums work only for the objects you kept checksums of. That sentence describes most integrity programs more honestly than any marketing page.

### 3.5 Credentials not used from outside: a 3-second correlation

This is the methodologically sharpest part. The question is whether a stolen storage key was used elsewhere. Access logs are per-object, but which key signed which request is blurry. So they took the **288 versions and markers** listed between 18:00 and 20:00 and checked, for each one, whether a log record for the **same key within 3 seconds** existed. It did, in every case.

| Item | Value |
| :--- | :--- |
| Logs expanded | 11,379 objects / 15,635 records (record times 14:56–20:59) |
| Versions & markers, 18:00–20:00 | 288 = `hexpm-prod` 231 + `elixir_ghactions` 33 + `bob` 24 |
| `hexpm-prod` requests | 6,279, all from three node IPs |
| Absent | `DELETE.OBJECT`, any request naming a version ID, ACL/tagging writes, copies, bucket listings by `hexpm-prod` |

That combination proves no storage object was deleted or overwritten with a stolen key. It does not prove **reads**. For private packages and docs, only CDN logs were checked; **direct reads from cloud storage are not logged.** The report says it plainly: a read from a compromised server would look like one of theirs.

### 3.6 And then: 0.47 MB/s

Beneath the sentence about network traffic staying normal is a qualifier.

> Network traffic stayed within normal levels, except one worker server that peaked at 0.47 MB/s against a usual maximum of 0.29 MB/s.

One worker's egress reached 1.6× its usual maximum. That is the only near-real-time side channel of a blind command execution on six servers for thirteen minutes. It is also the argument for the next section: **the detection should have come from a metric like this one, not from an error tracker doing its day job.**

One more check deserves mention because anyone can reproduce it: they listed every server with its creation time and build from the deployment pipeline, and stood the old and new builds side by side and fired the same payload at both. The old build ran the command, the new one rejected the request. **Deploy-pipeline instance history plus a two-build reproduction** — that is the entire toolkit behind sections 3.2 and 3.5, and it is available to any team running containers.

## 4. The same broken invariant, a third time: cursors

The November 26 piece tabulated the Ash, db_connection and Flop records. Their fix code is now public, and Flop's route is a different shape from hex.pm's.

### 4.1 Flop: the chain starts at a type-cast error

Flop is the Phoenix pagination library. Its `after`/`before` cursors are Base64-encoded Erlang terms. Before the fix, `Flop.Cursor.decode/2` called `:erlang.binary_to_term/2` with `[:safe]` and then a `sanitize/1` that rejected functions, PIDs, ports and references. **Maps passed. A struct is a map.**

The chain starts differently. With a `:naive_datetime` sort field, Flop casts the cursor value against the Ecto type. A `DateTime` struct is accepted, and the types of its fields are not checked — so a `DateTime` whose `year` holds another struct survives. Ecto then fails to cast it, builds an `Ecto.Query.CastError`, and **inspects the value to write the error message.** `Inspect.NaiveDateTime` raises because `year` is not an integer; the resulting `Inspect.Error` inspects its own arguments, which contain the nested struct. From there, it is the same tail as hex.pm: `Ecto.Query.DynamicExpr` → `DBConnection.Stream` → `:log`.

On hex.pm the trigger was `Plug.MethodOverride`; on Flop it was an Ecto cast error. The common element is an ordinary, well-intentioned act: **inspecting a value to produce a nice error message.** Logging and error reporting are assumed to be observation, not an execution path. This chain broke that assumption three times in one week.

### 4.2 Ash: verify first, decode second

Ash's fix is not a struct check. It changed the encoding of unsigned keysets. From the module docs:

- **With a signing secret:** encode with `:erlang.term_to_binary/1` and sign with an HMAC. Only keysets with a valid signature are decoded, so everything decoded was produced by this application.
- **Without a secret:** dump values to JSON. JSON cannot produce structs, functions or atoms, and each value is cast back with the same `Ash.Type.coerce/3` used for client-supplied filters.

```elixir
defp decode_values(values, key, signing_key) do
  result =
    if signing_key do
      decode_signed_term(values, signing_key)
    else
      decode_json(values)
    end
  ...
end

# Terms are only ever decoded after their signature has been verified, so they
# were generated by this application, and their size doesn't need to be limited.
defp decode_signed_term(encoded, signing_key) do
  with {:ok, bytes} <- Base.decode64(encoded),
       {:ok, message} <- verify(bytes, signing_key),
       :ok <- check_uncompressed(message),
       term <- non_executable_binary_to_term(message, [:safe]),
       :ok <- check_no_expression(term) do
    {:ok, :term, term}
  else
    _ -> :error
  end
end
```

The comment is the design principle: **terms are decoded only after their signature is verified.** Once authentication precedes decoding, whether the decoder tolerates structs stops being a security boundary. The boundary moved from data format to authentication. Two guards came along: a size cap on unsigned keysets, and rejection of compressed ETF payloads (`<<131, 80, ...>>`). And `Ash.Expr.expr?/1` stayed as defence in depth rather than the primary control, because a check that does not look inside structs cannot be the thing that carries the weight.

### 4.3 db_connection: delete the `apply`

The fix that breaks the chain's last link deleted one clause:

```elixir
# before
defp log({mod, fun, args}, entry), do: apply(mod, fun, [entry | args])
defp log(fun, entry), do: fun.(entry)
```

```elixir
# 2.10.3
defp log(fun, entry), do: fun.(entry)
```

Normalization of `{module, function, args}` into a closure moved to where the object is constructed — `stream/3` and `prepare_stream/3` call `normalize_log/1`. Every enumeration path (`declare/4`, `prepare_declare/4`, `stream_fetch/4`, `stream_deallocate/4`) now uses `already_normalized_meter/1`, which does not normalize. A forged struct never passes through `stream/3`, so its `:log` stays a raw tuple, and `fun.(entry)` on a tuple is a `BadFunctionError`. **Not having been normalized becomes the validation.** The CVE record is honest about scope: not exploitable in db_connection alone, and the record exists because the struct was used in real attacks.

## 5. Where the patches actually are (as of November 28)

A CVE record and a package release are not the same event. Here is each repository checked against Hex.

| Target | Fix commit | Latest release | Status |
| :--- | :--- | :--- | :--- |
| **hexpm** | `379b0a2` (11-23 18:26) | deployed 18:31 | **live** |
| **db_connection** | `9a4230a` (11-23 19:26) | **2.10.3** (11-24) | **released** |
| **ash** | 3.38.0 (11-24) | **3.38.1** (11-24) | **released** |
| **flop** | — | **0.26.7 · 0.27.3 · 0.28.1 · 0.29.2** (11-24) | **released** |
| **ecto** | `b6812d4` (11-23 19:22) | **3.14.3** (11-04) | **not released** |
| **plug_crypto** | `661a43f1d8` (11-24 09:47) | **2.2.1** (10-23) | **docs only, unreleased** |
| **Hex client** | — | **v2.7.0** (11-06) | **new signing client pending** |

Two rows need emphasis.

**Ecto's Inspect guard is not in a release.** 3.14.3 shipped on November 4, before the November 23 commit. And that commit is not one guard: titled "Improve explicitness of inspect implementations," it adds `is_list` guards across the whole Inspect surface — `DynamicExpr`'s `fun` and `binding`, the fields of `Ecto.Query`, `assocs`, `params`, `subqueries`, `json_extract_path`, `joins`. 36 insertions, 15 deletions, all saying the same thing: an Inspect implementation must not enumerate a field it has not verified.

Practically, the chain is still breakable today because db_connection 2.10.3 is out. The Ecto guard is defence in depth, not the only choke point — so **upgrade db_connection first** and add Ecto when its release lands, since a future Inspect gadget would then have fewer places to be stopped.

**plug_crypto got a documentation warning, and not even that has shipped.** The November 24 commit added this to the docs of `non_executable_binary_to_term/2`:

> If you are encoding data using `:erlang.term_to_binary/2`, sending it to an untrusted actor, and decoding it using this function, we strongly advise you to sign or encrypt the payload before sending, and verify it on receiving. Although this function rules out anonymous functions, idioms such as `{module, function, args}` tuples may still be injected anywhere within the decoded data-structure (such as within structs) to invoke custom code.

Accurate. But reading HEAD shows `non_executable_terms/1` still walks maps without ever looking for a `__struct__` key, and the latest release (2.2.1, October 23) predates the doc change. The hardening this disclosure listed as in progress is genuinely still in progress.

**The Hex client is also pending.** Latest is v2.7.0 from November 6. The new registry signing system with key rotation is not shipped, the registry signing key was excluded from the rotation, and therefore **"use only repo.hex.pm, no mirrors" remains in force today.**

### 5.1 What to check on your own service

```bash
mix deps | grep -E "ash|db_connection|flop|ecto|plug_crypto|plug "
# thresholds: ash >= 3.38.0, db_connection >= 2.10.3,
#             flop >= 0.26.7 / 0.27.3 / 0.28.1 / 0.29.2 by branch,
#             ecto: guard release not out as of 11-28
```

Flop has four maintained branches with separate patch versions. Next: does your app actually use cursor pagination? All four records require it. `pagination_types: [:page, :offset]` removes the exposure until you upgrade. If you self-host hexpm, you are exposed in the **server**, not the client: apply `379b0a2` and `2d0be98a` — the second one (19:06) refuses structs in **release tarball metadata**, meaning the same bug existed in two places.

And verify the patch the way the vendor did: stand a fixed build and an unfixed build side by side and send a struct-carrying term. `400` versus `500` is the assertion. Then send a normal client request and confirm the response did not change — the check that security patches most often skip.

### 5.2 Building the telemetry that was missing

"The logs do not show it" was the central problem, and it was a design problem, not bad luck. If you run anything that decodes request bodies, these are the four gaps to close.

| Missing today | What closes it | Cost / caveat |
| :--- | :--- | :--- |
| Database reads | `pgaudit` `log_select`, or SELECT auditing scoped to sensitive tables | Full SELECT auditing explodes; scope it per table |
| Process execution | `auditd` `execve` rules, or Falco shell-spawn detection in containers | A BEAM node almost never spawns `sh`; `beam.smp` → `sh`/`curl`/`nc` is a signal on its own |
| File writes | Read-only root filesystem + monitoring of writable paths | A file appeared in 3 ms. That was catchable |
| Egress | Per-pod bandwidth baselines, alerted on ratio not absolute | 0.47 vs 0.29 MB/s — alert on multiple of usual maximum |
| Decode failures | Structured logs of parser rejections with media type, path, source | Sentry played this role by accident at hex.pm |

Three application-level rules follow:

- **Verify, then decode.** Ash's fix is the textbook: it is easier to remove untrusted input from the decode path than to make a decoder safe forever.
- **One decode boundary.** hexpm put the check in the single decoder for that format. Per-route checks eventually miss one; this incident happened exactly where a check had been removed altogether.
- **Treat error reporting as an attack surface.** `inspect/1` is protocol dispatch. Every layer that inspects request data — Sentry, framework error logs, JSON formatters, cast-error messages — is a dispatch point. Three of this week's four records fork there.

## 6. Established, reconstructed, unknown

**Established.** 69 requests in 13 min 33 s; six web servers, half of them brought back by an 18:28 restart; first file at 3 ms; fleet patched 18:30–18:31; full block 18:33:48; fix commit 18:26:41. No database writes (full comparison against an 18:13:59 snapshot), package and registry checksums matching (23/62/186), storage credentials unused from outside (288 versions and markers correlated within 3 s; 6,279 requests from three node IPs), no shells left running. Release status: db_connection 2.10.3, ash 3.38.x, flop 0.26.7/0.27.3/0.28.1/0.29.2 shipped; Ecto guard unreleased; plug_crypto docs-only and unreleased; Hex client still v2.7.0. None of the four CVEs is in CISA KEV (catalog 2026.11.27, 1,808 entries).

**Reconstructed.** The causal link between the 18:28 restart and three vulnerable servers comes from the per-server creation-time and build comparison; other coverage of this incident does not state that chain. The November 19 downloads are "suggests a local copy to test against," and nothing says what was done with it. The 0.47 MB/s peak cannot be attributed to command execution; the report only calls it an exception within normal range.

**Unknown.** Which commands ran and what they read. Whether database rows were read, and which. Whether private documentation was read directly from storage. Who the attacker is (the report says only "two addresses"). Activity before November 19. Whether the vulnerability was exploited elsewhere before November 23.

One closing note about why this disclosure is worth studying even beyond the bug. The strongest thing the vendor did was not patching in twenty minutes. It was **splitting "proven" and "not ruled out" sentence by sentence.** Keep those apart and the report can be used for audits, regulators and customers a year later. Blur them and the same findings get quoted as both "a breach happened" and "nothing happened." The quality of an incident report is measured not by how firm the conclusion is, but by where it draws the edge of what it knows.

*Originally published in Korean at [dohyeontech.github.io](https://dohyeontech.github.io/posts/hexpm-incident-69-requests-forensics/).*
