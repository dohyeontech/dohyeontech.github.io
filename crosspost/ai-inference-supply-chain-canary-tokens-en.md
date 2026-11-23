---
title: "ZDR Didn't Stop the Storage: What 2 Million Canary Prompts Found in the AI Inference Chain"
subtitle: "Dragos planted unique credentials in two million requests and watched where they surfaced. Three hosting providers were breached, marketplace resellers harvested prompts through ordinary logging, and privacy flags held only for the first hop."
canonical_url: "https://dohyeontech.github.io/posts/ai-inference-supply-chain-canary-tokens/"
cover_image: "https://dohyeontech.github.io/assets/images/thumb_ai_canary_en.png"
tags: [security, ai, cloud, privacy]
source_ko: "https://dohyeontech.github.io/posts/ai-inference-supply-chain-canary-tokens/"
---

*This is the English adaptation of the original Korean analysis at [dohyeontech.github.io](https://dohyeontech.github.io/posts/ai-inference-supply-chain-canary-tokens/).*

Between 10 and 22 November 2026, four inference providers and one router published security notices. Phala on the 10th, Dragos with the underlying research on the 19th, Together AI on the 21st, and OpenRouter, Novita and Atlas Cloud on the 22nd. They read like separate incidents. They share the same bait: roughly **two million prompts** that HD Moore's team at Dragos seeded with per-request credentials and unique URLs between July and November, then watched.

The results split three ways.

- **Three hosting providers were actually compromised.** Moore's planted AWS keys were used in live attacks — enumerating S3 buckets, enabling Bedrock models, creating IAM users. The earliest incident dates to mid-July, and none of the three knew until Dragos told them.
- **Marketplace resellers read and retained customer prompts without exploiting anything.** List a model at the lowest price, turn on request logging, wait. The same model sent through a different seller was never touched, and that contrast is what identified the seller.
- **Privacy settings were not honoured.** One Chinese lab's systems fetched the secret URLs from more than half the prompts sent to its models between July and October, including roughly two-thirds of those marked "no data collection" or ZDR. A ZDR-flagged link turned up 24 days later in an internal Feishu chat and was opened within two minutes on three desktops and three phones in Beijing and Shanghai.

The interesting question is not whether AI leaks. It is **which layer sees what, and how far a setting actually reaches**. Because the answer to the second one is shorter than most operators assume.

## 1. The request crosses the stack in plaintext

An inference path is longer than the API call suggests. Your application posts to a router, which picks an upstream by model and price. That upstream may be another router, a marketplace seller slot, or the hosting provider that actually holds the GPUs. One traced path in the Dragos data looked like this:

```
[customer app] → [router A · Vercel/OpenRouter etc.] → [marketplace seller]
              → [second router/gateway] → [hosting provider] → [model server]
```

Every hop decrypts the body. The router needs the token count and model name to price the call. The seller needs it to pick a model. The provider needs it to run inference. TLS protects each leg, not the whole path. Dragos puts it plainly: every hop can see the entire prompt and response.

| Layer | What it can read | What control remains |
|---|---|---|
| Customer gateway (LiteLLM etc.) | Everything | Your own logging policy, masking |
| Router | Everything + account settings | Data-policy routing, endpoint list |
| Marketplace seller | Everything | None. The seller's terms |
| Second router | Everything | None (may not appear on the advertised route) |
| Hosting provider | Everything, in memory during inference | Their security, their audit |
| Model owner | Everything, when the model is theirs | Their terms |

The structure is optimised for plaintext forwarding. To cut cost you send requests to the cheapest place, and to do that you have to read them. OpenRouter's documentation describes its default routing exactly that way: each request is placed with the provider that looks best on measured price, throughput, latency and reliability. Price is an input. Moore's line — that if you don't decide where your prompts go, the lowest price decides for you — is not a metaphor.

A few documented details matter more than they look, all from OpenRouter's public docs:

- `allow_fallbacks` defaults to **true**. Pin a provider, get a 429, and the request quietly goes elsewhere.
- Follow-up turns stay on the same provider while the prompt cache is warm. Whoever saw the first message sees the whole conversation.
- In-region routing (US, EU) is Business/Enterprise only.
- ZDR enforcement applies **only to provider routing**. Plugins and tools you enable — web search, web fetch — follow their own retention policies.
- A provider whose policy cannot be determined is treated as retaining and training on data. That is a sound conservative default, and also an admission: the policy metadata is self-reported.

The definition of ZDR is narrower than the name. OpenRouter defines it as "no routine storage of prompts or responses after processing," and keeps a separate **Safety Retention** tier that permits retention for abuse investigation without the request being flagged. From 27 October 2026, all inference requests — ZDR included — are screened in flight for CSAM, and flagged content may be retained for human review, reporting and legal preservation.

That is where the common misreading happens. "ZDR is on" is a promise not to retain. It is not a guarantee that nobody reads. Any read path — abuse scanning, content review, support tooling, debugging — produces a queue, a cache or a log, and a log is storage.

## 2. Root cause: retention lives at the write point, leakage happens at the read point

The three failure classes have different owners and different fixes. Underneath them is one broken invariant: **a retention policy is not an access control.** Once the data is plaintext inside a layer, "do not store" prevents nothing.

### 2-1. Rejected requests were stolen too — copies at the front door

The strongest evidence came from requests that never ran. Dragos put one AWS key into one request. In short windows in late October, **every request sent in those windows was stolen, including requests the provider rejected before a model executed.**

A rejected request never reaches model routing, token accounting or ZDR endpoint selection. If its body was in the attacker's hands, the copy happened at the **ingress edge**: TLS termination, authentication, rate limiting, request logging, routing entry. All of that sits in front of the pipeline.

ZDR is evaluated further down, as a routing filter. An attacker at the front door never lets it execute. Moore's sentence is precise: "A privacy flag doesn't help when the attacker is already inside."

The engineering question is not how they bypassed the check. It is **why the body of a rejected request was being stored in the first place.** Most gateways log request bodies for 4xx/5xx debugging. That log is the exfiltration copy. During incident response, "what did we leak" matters less than "what is still sitting in our logs."

### 2-2. Reseller logging is not a vulnerability, it is the product

The second failure needs no exploit. A seller lists a model at the lowest price, enables request logging, and the traffic arrives. Moore describes the economics: undercut to pull volume, absorb the difference, harvest the platform logs. At the darker end, some of that capacity is billed to stolen AWS credentials or consumer-plan API keys.

The experiment design is what made attribution possible. The same model was sent through **different sellers**. A secret URL routed through one seller was opened a day and a half later in a desktop browser on residential broadband, with somebody guessing usernames at the login page. The same model through another seller was never touched. The leak follows the seller, not the marketplace.

A Mac on residential broadband in France took passwords from two prompts and tried root SSH **by hand, four times in two minutes**. The same Mac then tested several AWS keys in one session. This was people at keyboards.

Route hiding compounds it. One router was quietly forwarding traffic to a marketplace without saying so. One seller appended roughly **a thousand hidden tokens** to every prompt. Another fetched images through a shared consumer subscription account. One key that had been sent to a completely different router was later used alongside marketplace keys — evidence that the router was passing traffic through.

The invariant that dies here is "endpoint equals trust anchor." In a marketplace, an endpoint is an economic slot. The party offering the lowest price today need not be the party serving that model tomorrow.

### 2-3. The ZDR flag binds only the first hop

The third failure used no credentials at all. Secret URLs in prompts were fetched repeatedly, and a git client tried to clone the private repositories they referenced.

The clearest case is the lab Dragos leaves unnamed. Its systems fetched secret URLs from **more than half** of the prompts sent to its models from July through October, including about **two-thirds** of those marked "no data collection" or ZDR. The scraper typically appeared two or three days later.

It was not limited to direct requests. Several U.S. hosting providers resell that lab's models, and prompts sent to those providers triggered **the same scraper**. A customer who chose a U.S. provider specifically to keep data in the U.S. did not get what they paid for, because the prompt went back to the model owner. The clone attempts from a different cloud appeared **only** for prompts that used that lab's models.

The large U.S. providers have their own problems. One kept crawling a secret URL more than **two months** after a single call to its search endpoint. Another runs a scraper that returns days after each request regardless of which router was used to reach it.

Why ZDR cannot help: the flag is consumed by the **first hop's routing decision**. That hop can honour its own rule — only pick ZDR endpoints. It has no mechanism to impose the same rule on the provider behind it, the model owner, or a content-review pipeline. It is a setting, not a contract. Novita's notice illustrates the structure almost by accident: the company is investigating whether "automated content review" was involved. Content review has to read the prompt, and read pipelines tend to log.

### 2-4. Production prompts copied into a dev store — Together AI

Together AI's incident is a data-handling failure rather than a layer failure. Per its notice, the company kept prompt samples in a **private Hugging Face repository** for routine software testing. The samples came from MiniMax M3, GLM-5.2 and Kimi K2.6 requests, mostly on 24 June, 4 July, 8 July and 14 July. Together states the samples were "authorized for that use" — the purpose was legitimate.

The chain has four steps:

1. A credential with access to the private HF repo existed.
2. While developing the public GitHub repository `xorl`, an **AI coding agent committed that credential**.
3. Automated scanning detected it and reverted the commit. The exposure window had already opened.
4. An unauthorised party downloaded the samples, searched them for credentials to other services, and tested which were valid. Five were Dragos canaries.

Reverting a commit does not revert a leak. From the moment it is public, the repository is subject to crawlers and forks, and the scan measures how long the commit stayed, not how long it was read. Together's remediation list matches that diagnosis precisely: scoped or short-lived credentials, keyless access where supported, credential checks on every pull request, **ZDR as the default for new accounts**, and updated rules for AI coding agents. The last two are an admission that defaults beat attention.

Worth stating separately: using production prompts as a test corpus is upstream of this incident. If synthetic data or hashed token statistics will not suffice, every copy of the raw prompt is one more thing that can leak.

### 2-5. Trusting a network position instead of authenticating — Phala

Phala's incident is a genuine intrusion with a classical path.

The exposure window opens at 00:00 UTC on 21 October. The attacker chained a **legacy internet-facing service** with management interfaces that **relied on loopback access for trust and did not independently authenticate callers**. That let them create unauthorised confidential VMs and obtain application credentials. Detection came on 5 November, containment that day, KMS root key rotation on 6 November. The attacker kept trying after the rotation and did not succeed.

The harder part came next. On 8 November a third-party researcher supplied evidence that request data sent to DeepSeek V4 Flash 0731 had been exposed. It traced to an inference deployment on a **new GPU server that was serving production traffic without full production hardening**. The attacker used a similar access pattern to take control of that inference VM, **making in-flight request data visible during processing**. The deployment was taken offline between 04:12 and 05:35 UTC.

| Time (UTC) | Event |
|---|---|
| 10-21 00:00 | Exposure window opens; management interfaces reached, malware inserted |
| 10-21/22 | Window in which requests were confirmed exposed (canary evidence) |
| 10-22 05:41 | Earliest observed misuse of stolen data |
| 11-04/05 | Second server tampered with, unauthorised CVM created |
| 11-05 08:15–17:55 | First intrusion contained; legacy services disabled |
| 11-06 05:02 | KMS root key rotation completed |
| 11-08 04:12 | Researcher evidence traced to the unhardened deployment |
| 11-08 05:35 | Containment completed |
| 11-09 | Most recent observed misuse |

Treating loopback as authentication is an old mistake. The lesson here is different: **a platform selling confidential computing can still expose prompts in plaintext when its own deployment hardening gate is empty.** Attestation protects a workload from its host. It does nothing when the control plane that launched the workload is compromised. Phala has not published the full RCA yet.

## 3. Exploit mechanics and indicators

### 3-1. Canary design: one fingerprint per request

The experiment began with Thinkst Canarytokens and grew into a dedicated service. The design is simple and strong:

- Generate a unique seed per request, then **derive** hostnames, URLs and credentials from it.
- Run the derived targets as real services: DNS, HTTP, git, SSH, databases, mail, assorted legacy protocols.
- The AWS keys are **real keys on empty accounts with logging enabled**.
- Every touch is tied back to the prompt, model, router and privacy setting that carried it.

Derivation is what makes attribution possible: a hostname alone identifies its seed, so the DNS server used, TLS SNI, HTTP Host header, URL path, credential and arrival time all collapse onto one request. That is also why two million prompts were needed. Only with samples for each combination — router × seller × provider × model × flag — can you claim "it leaked on this path and not that one." The seller attribution in section 2-2 is a product of that comparison.

### 3-2. Route tracing: image callbacks and three or four nested error envelopes

Canaries tell you a prompt leaked, not where. A router usually reports a single upstream, and that upstream may be another router. Dragos added two tricks to build something like traceroute for inference.

First, include an **image URL** pointing at their servers. Every system that fetches it leaves an IP, an HTTP client and a timestamp.

Second, send **slightly broken requests**. Routers wrap the error from the hop behind them in their own format, so a single response can carry **three or four nested envelopes**. Matching each layer against a signature database yields the hop list, the software at each hop, the network, and often the operator. About **2,000 routes** have been traced; several hundred included an unidentified system, and a handful sent the image to a company that was not on the advertised path.

You can approximate this. Send one nonexistent parameter to your router and compare the JSON keys and `X-` headers in the error body. Upstream errors are often passed through with a wrapper intact, which gives you a lower bound on your hop count.

### 3-3. Credential abuse sequence

The canary keys show the standard post-compromise path.

| Step | Action | Observable |
|---|---|---|
| 1 | Validate the key, sometimes within hours | First API call |
| 2 | Enumerate S3 | `s3:ListBuckets`, `s3:ListObjects` |
| 3 | Search Secrets Manager and Parameter Store | `secretsmanager:*`, `ssm:GetParameter*` |
| 4 | Enable Bedrock models, create Bedrock API keys | `bedrock:*` |
| 5 | Create their own IAM users | `iam:CreateUser`, `iam:AttachUserPolicy` |
| 6 | Maintain access | One key still in use three weeks later |

Total volume was **tens of thousands** of API calls. One key was seeded on 21 October, first used the next day, and **still active three weeks later**. Exposure windows that count only the leak date understate the risk; without rotation, the attacker's window is longer than the leak.

There is also evidence of one actor hitting two providers at once: secrets sent to both were used together, almost immediately, from a single rented server.

### 3-4. Tooling evolution and user-agent IOCs

Over three weeks the tooling changed four times: a script impersonating Chrome on Windows, then Boto3 inside OrbStack, then the AWS CLI on Kali Linux, and on 1 November **ARTEX**, an LLM-driven penetration-testing framework.

ARTEX did very little here — a handful of calls confirming that already-held keys were live. But two user agents it sent, `artex-agent` and `artex-judge-r121`, do not appear in any public indicator list. They belong in detections.

The good news is that these tools announce themselves: Kali and ARTEX show up in the `userAgent` that AWS records in CloudTrail. The bad news is that this self-identification appeared in only a fraction of the traffic, so UA matching is necessary and not sufficient.

```json
// Fields worth reading in a CloudTrail record
{
  "eventName": "CreateUser",
  "userAgent": "aws-cli/2.x ...",
  "sourceIPAddress": "…",
  "userIdentity": { "type": "IAMUser", "accessKeyId": "AKIA…" }
}
```

The strongest signal is a **sequence**, not an event: within hours of a key being seeded, `ListBuckets` → `GetSecretValue` → `CreateUser` on that key. Normal automation does not move in that order.

### 3-5. When a human reads it: day 24

The coldest observation is organisational. Twenty-four days after a prompt went to a Chinese provider, its secret link was posted in a Feishu (Lark) channel. Within two minutes it was opened on three desktops and three phones in Beijing and Shanghai.

The detail that settles it: the request had gone to a **U.S.-based provider with the ZDR flag set**, and Dragos's disclosure to that provider included only the **first eight characters** of the link. Eight characters cannot reconstruct the URL. Whoever posted it was reading from a stored copy of the full prompt.

This falsifies one proposition: "nobody read it." A promise not to retain holds only inside a system boundary. A copy that crossed the boundary makes it meaningless, and those copies usually come from legitimate work — review, support, debugging.

### 3-6. Detection checklist

**Customer side**

- Dedicated canary IAM user; alert on `ListBuckets` / `GetSecretValue` / `CreateUser` / `bedrock:*`
- CloudTrail `userAgent` containing `artex-agent`, `artex-judge-r121`, `aws-cli` from unfamiliar addresses
- Time between first use of a key and its last use — the basis for rotation
- Outbound DNS/HTTP attempts toward internal canary hosts

**Provider and router side**

- Periodic audit that ZDR-flagged request bodies are absent from logs. Presence is the violation
- Divergence between advertised and traced routes
- Token-count inflation against the declared prompt (hidden token insertion)
- Per-seller comparison of the same model, and abandonment rates per seller

## 4. Patch analysis: what each vendor fixed, and what it did not

| Party | Action | What it actually fixes | What remains |
|---|---|---|---|
| OpenRouter | Off-boarded 3 providers, removed **125** endpoints from ZDR eligibility, notified all potentially affected customers | Known bad routes, label contamination | Marketplace economics, hidden hops, self-reported metadata |
| Together AI | Scoped/short-lived credentials, keyless access, PR credential checks, **ZDR default for new accounts**, agent development rules | Recurrence of this pattern | Existing customer data handling, test-corpus practice |
| Phala | Disabled legacy services, network controls, KMS root key rotation, server offline, restored with protections and monitoring | This intrusion path | Deployment hardening gate (process) |
| Novita | Suspended affected models, improved partner API labelling and disclosure, following up on retention and deletion | Concealed forwarding path | Roughly five and a half months of forwarding (28 May – 11 Nov) |
| Atlas Cloud | Stopped sending to MiniMax's official API, withdrew all its own models from OpenRouter voluntarily, tests with Dragos four times a day | Upstream dependency | Trust in the upstream itself |

Read the OpenRouter number carefully. Removing 125 endpoints from the ZDR list means **a meaningful share of what was listed as ZDR may not have been**. Some were named by researchers, some removed as a precaution. The three off-boarded providers were not named. Of the three providers Dragos identified as breached, only Phala has publicly confirmed it; the other two remain anonymous. Overlapping the two lists is an inference, not a finding. Novita's and Atlas's notices concern requests forwarded to MiniMax's official API, which is a different failure from a host breach.

OpenRouter says it was not breached. Novita says it does not retain prompts. Atlas says it did not store those requests. All three statements can be true per hop. None of them is true end to end.

### 4-1. Exposure windows and what to rotate

| Service | Models | Window | Basis |
|---|---|---|---|
| Phala (via OpenRouter) | DeepSeek V4 Flash 0731 | 2026-10-21 00:00Z – 11-08 05:35Z | Treat request contents as exposed; rotate secrets |
| Novita | MiniMax family | 2026-05-28 – 2026-11-11 | Third-party access or retention possible |
| Atlas Cloud | MiniMax M3, M2.7 | Q3 – early Q4 2026 | Forwarded to MiniMax's official API |
| Together AI | MiniMax M3, GLM-5.2, Kimi K2.6 | centred on 6-24, 7-04, 7-08, 7-14 | Stored test samples downloaded |

Rotate everything that was in those prompts: API keys, tokens, passwords, private URLs, database strings. **Signed URLs** are the ones people forget. A long-lived S3 presigned URL survives key rotation; bucket policy and object permissions have to be reviewed separately.

### 4-2. Operator checklist

**(1) Take the router off its defaults.** `allow_fallbacks` defaulting to true is reason enough to set this explicitly.

```json
{
  "model": "anthropic/claude-sonnet-4.5",
  "provider": {
    "only": ["anthropic"],
    "allow_fallbacks": false,
    "data_collection": "deny",
    "zdr": true
  }
}
```

This binds **the one hop you configured**. If the upstream inserts a reseller, nothing behind it is guaranteed. Treat router settings as a floor, and verify above it.

**(2) Seed your own canaries.** Put a unique bait URL in every prompt you send and alert when it is fetched. A free Thinkst Canarytoken works today; so does this.

```python
# canary.py — one unique bait per prompt, and a record of every fetch
import http.server, socketserver, secrets, threading, time

HITS = []
BASE = "https://canary.example.net"   # reachable from the internet

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        HITS.append({
            "token": self.path.strip("/"),
            "ts": time.time(),
            "ip": self.client_address[0],
            "ua": self.headers.get("User-Agent"),
            "host": self.headers.get("Host"),
        })
        self.send_response(404)          # look like a missing resource
        self.end_headers()
    def log_message(self, *a):
        pass

srv = socketserver.TCPServer(("0.0.0.0", 8787), Handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()

def seed(prompt: str):
    token = secrets.token_urlsafe(16)
    tagged = prompt + f"\n\n[internal reference: {BASE}/{token}]"
    return tagged, token            # keep token → request mapping outside the prompt
```

Two rules: the bait must be **unique per request** so you can name the request that leaked, and the token-to-request map must live **outside** the prompt, or the bait becomes another leak. In practice the bait sits in a tool description or a list of reference documents — anywhere the agent reads.

**(3) Move secrets out of the prompt.** This is the only defence in the entire incident that held. Environment variables an agent can read count as part of the prompt: Together's credential was in the repository and the agent could read it, which is why it was committed. Issue per-task tokens that die with the task, and prefer keyless OIDC.

**(4) Redraw the logging boundary.** Turn off request-body logging, or separate it from ZDR paths. The body of a rejected request is an attacker's favourite log, and section 2-1 is exactly that.

**(5) Separate only the sensitive workloads.** Dragos lists the cost curve: a 512 GB Mac Studio at $22,299, a DGX Spark at $6,950, a DGX Station around $105,000, an eight-GPU B300 server from $570,000. You do not need to self-host everything. The workflows that actually contain secrets are few, and moving those to private endpoints or your own GPUs removes most of the exposure surface.

**(6) Treat provider policy as an asset.** Keep a table: unknown retention, 30 days, ZDR. OpenRouter's own provider table lists MiniMax as retaining prompts "for unknown period" and DeepSeek as unknown plus may train. Assuming retention when a policy cannot be established is the documented default, and a reasonable one.

## 5. What remains

The three failures need different responses. A **hosting breach** is a classic incident: whoever has code execution or log access at the front door sees everything, ZDR included. It is a vendor response and isolation problem; the customer's job is rotation and detection. **Reseller logging** is a business model, not a vulnerability. There is no code to patch, only off-boarding and reputation. **Policy non-compliance** sits closest to breach of contract, and it is the widest, quietest and hardest to fix.

The canary experiment's real contribution is not "AI is dangerous." It made a claim **measurable**. "We do not store your prompts" became a proposition testable per request. Its limit is equally clear: canaries detect **use**, not **copying**. A stored copy nobody touches is invisible. The Feishu case surfaced because someone eventually used it; for 24 days the copy existed unobserved.

So the questions a developer can actually act on today are short. Do you know how many hops your prompts cross? Can you name the retention policy of each one? And is there an unrotated secret inside the prompt, anywhere an agent can read?

ZDR is a sign that says "nothing is stored here." It is not the lock. Locks have to be fitted separately.

---

Primary sources: Dragos, "AI Supply Chain Security: What Canary Tokens Found" (HD Moore, 2026-11-19) · Phala, "November Preliminary Incident Report" (2026-11-10) · Together AI, "Security event: Prompt leakage for requests in June and July of 2026" (Vipul Ved Prakash, 2026-11-21) · OpenRouter, "Data Processing Incidents on Inference Providers" (2026-11-22) · Novita, "Privacy Notice Regarding MiniMax Requests on Novita" (2026-11-22) · Atlas Cloud, "Security notice: MiniMax's official API and how we protect your data" (2026-11-22). Policy and routing details were read from OpenRouter's public documentation (Zero Data Retention, Provider Routing, Provider Logging). The report that OpenRouter removed the ZDR label from MiniMax endpoints on 21 November is from Ars Technica (2026-11-20, updated 11-21). Of the three providers Dragos confirmed as breached, only Phala has been publicly identified; the other two remain anonymous, and OpenRouter has not named the three it off-boarded.
