---
title: "A GitHub Account Was the Deploy Key: Reading the 1Password Backend Breach"
subtitle: "An employee's corporate GitHub identity pushed code into production backends, and that code walked out with customer account records. The vaults survived because the keys were never on the server. What the disclosure establishes, what the SRP verifier actually exposes, and why lengthening a 6-digit code to 10 characters is not the control that matters."
canonical_url: "https://dohyeontech.github.io/posts/1password-github-cicd-backend-breach/"
cover_image: "https://dohyeontech.github.io/assets/images/thumb_1password_github_cicd_en.png"
tags: [security, github, devops, cryptography]
source_ko: "https://dohyeontech.github.io/posts/1password-github-cicd-backend-breach/"
---

*This is the English adaptation of the original Korean analysis at [dohyeontech.github.io](https://dohyeontech.github.io/posts/1password-github-cicd-backend-breach/).*

On 19 November 2026, 1Password started an investigation after seeing indications that an attacker had gained access to an employee's corporate GitHub account. The disclosure that followed six days later is four paragraphs long, and one of them carries the whole weight: the actor used that account to reach source code and **push malicious code to backend services**, and that code downloaded administrative data about customers.

For a password manager, the sentence has a specific shape. No product vulnerability was exploited. **One person's repository write permission became the company's production execution path, and that execution path could reach customer records.** What survived and what did not is the entire story. Cryptography survived: vault data is designed so the server cannot decrypt it, so a whole backend falling into someone's hands still did not open a vault. Identity-to-deployment separation did not survive.

This piece separates what the primary disclosure establishes from what is still unknown, then walks the leaked fields at the level that matters — what an SRP verifier is, why an offline dictionary attack against it fails here, what a verifier holder can still do, and what the 6-to-10 character change actually buys. The root cause analysis (RCA) is still pending, so instead of pretending to a patch diff, the last section reverse-engineers the controls each step of the chain should have passed.

## 1. The record, and the holes in it

### 1.1 Timeline

| Time | Event | Source |
| :--- | :--- | :--- |
| 2026-11-19 | Indications of GitHub account compromise; investigation opens | 1Password disclosure |
| (undisclosed) | When the account was first compromised — possibly before 11-19 | undisclosed |
| 11-25 | Public disclosure; community Q&A begins | 1Password blog/forum |
| 11-25 21:33 UTC | BleepingComputer report | BC |
| 11-26 03:32 ET | SecurityWeek report — adds the SRP verifier detail | SecurityWeek |
| 11-26 | The Register: "hasn't explained how access to an employee's GitHub account enabled the attacker to deploy malicious code" | The Register |
| later | Root Cause Analysis promised | 1Password disclosure (top note) |

Six days from detection to disclosure. In that window 1Password disabled the affected GitHub account, revoked the stolen token, removed access the attacker created, rotated or revoked internal credentials that may have been exposed, and restored clean versions of the affected service. What the document does **not** contain: how the employee's account was taken over, how many customers are in the affected "subset", or attribution. The Register and TechCrunch both asked and got no answer.

### 1.2 Affected fields, sorted by what they actually are

The disclosure lists six categories, and they mix three different kinds of thing: data that was never secret, secrets that were neutralized, and secrets the server never held. Each line needs its own label.

| Field | Nature | What it gives an attacker |
| :--- | :--- | :--- |
| Names and login email addresses | Identifier | A verified target list. The email *is* the 1Password login |
| Account/user IDs, account creation and last sign-in times | Metadata | Account existence, activity-window guesses |
| Public keys | Public by design | Nothing on its own |
| **SRP protocol parameters (including the verifier)** | **Secret-derived value** | Analyzed in §2.2 |
| Tokens in invitation, provisioning and recovery emails | **One-time credential** | Only accounts mid-flow at the time |
| Non-secret internal metadata (version and file numeric IDs) | Architecture hints | Internal structure mapping |

Separately: a copy of source code from private repositories, and access to the CI/CD system. 1Password states that CI/CD holds infrastructure secrets required for the product to operate, and that all credentials which may have been exposed have been rotated.

Explicitly unaffected: vaults and the items in them, the keys protecting those vaults, the account password and Secret Key (1Password does not store them), account recovery keys, and the apps and browser extensions.

### 1.3 "Unaffected" is stated at two different strengths

This matters and is easy to flatten. The same fact appears in three places with three different levels of certainty.

- Blog: "**At no time were** customer vault contents accessed by, or available to, the attacker."
- Community, 11-25 21:31 UTC: "We have **no evidence** that encrypted vaults were downloaded or accessed."
- Community, 11-26 05:11 UTC: "Our broader assessment with independent cybersecurity experts to validate the scope of the incident **is still underway**."

The first is a design claim: the server holds no decryption key, so access would not have yielded plaintext. The second is an evidence claim: whether ciphertext left the building is still being established. Both can be true, and the practical conclusion for a user is the same — the vault is safe — but "not downloaded" and "downloaded and unreadable" have not yet been separated. Quoting the two as one sentence overstates the record. The disclosure keeps them apart, and that is the honest way to write it.

## 2. Why the vaults did not open

### 2.1 Two-Secret Key Derivation puts the inputs off-server

1Password vaults are encrypted with a key derived through PBKDF2 from the account password **and** a Secret Key. The property that matters is that the server has neither input. The Secret Key is generated client-side and lives on the user's devices and in their emergency kit; the account password is never transmitted or stored.

So code running in the backend can reach ciphertext and authentication-derived values, and nothing else. This is not defense in depth, detection, or access control. **The key was not in the room.** The blast radius was capped by design rather than by response.

### 2.2 The SRP verifier: leaked, yet not attackable offline

The most technical item on the list is "Secure Remote Password protocol parameters." A community manager's answer (1P_Blake, 11-25 21:17 UTC) specifies what that includes: a **verifier derived from both the account password and the Secret Key**.

Per 1Password's own 2018 write-up on SRP, the enrollment flow is:

```
x = KDF(salt, account password, Secret Key)   # KDF = PBKDF2
v = g^x mod N                                  # N: 4096-bit prime, g: generator
server stores (salt, v) only — never x, never the password
```

During authentication the client and server exchange `A = g^a` and `B = g^b + k·v`, and each side reaches the same session key using `x` on one side and `v` on the other. The server authenticating a client from `v` alone is SRP's convenience, and it is exactly where a stolen verifier file becomes dangerous.

Three capabilities, one at a time.

**(1) Offline dictionary attack — closed here.** With a conventional SRP verifier store, the verifier is functionally an offline-crackable password hash: take a candidate, compute `x' = KDF(salt, candidate)`, and check `g^x' mod N == v`. Per-account salt defeats precomputation but not per-account guessing. In 1Password's construction, `x` also consumes a **128-bit random Secret Key** that the attacker does not have and 1Password does not store. The cost of enumerating candidates stops being "size of the dictionary" and becomes `2^128`. That is the calculation behind the community answer's "it also can't be used to brute-force your account password without your Secret Key."

**(2) Acting as the server — the residual risk.** Whoever holds `v` can complete an SRP handshake as the server, because the client's check that "the server knows the verifier" is satisfied by `v` itself. This requires being in the middle: a broken TLS trust chain (forged certificate, tampered device trust store) or a client pointed at the wrong endpoint. The payoff is also limited — a session key still does not decrypt a vault locked by `x`. But it is worth writing down that "the vault is safe" rests on **undecryptability**, not on **server authentication**. Those are different guarantees, and only one of them was stressed in this incident.

**(3) Account enumeration — the real damage.** Verifier plus salt plus a list of names and emails lets you answer "does this address have a 1Password account" offline. The leaked list already answers that question, so nothing new is gained directly; what changes is that this combination becomes an existence oracle when joined against other breach data sets.

Net: the leaked SRP parameters cannot log in and cannot decrypt. The risk is not the value, it is the **confirmed roster of 1Password users** and the trust-boundary erosion in case (2).

### 2.3 Invitation and recovery tokens: how long the second lock is

The most operationally important paragraph in the disclosure concerns tokens embedded in invitation emails (provisioning, covering SCIM Bridge and Hosted Provisioning) and account recovery emails. Such a token completes the flow **only when combined with SSO sign-in or a code sent to the user's registered email address**. It cannot reach an account by itself. A small number of users were in that state during the incident and were notified individually.

1Password then expanded the code from six numeric digits to **ten alphanumeric characters**. The entropy math makes the nature of that measure visible.

| Code format | Search space | Bits | vs. 6 digits |
| :--- | ---: | ---: | ---: |
| 6 numeric digits (previous) | 10^6 = 1,000,000 | 19.9 | 1× |
| 10 alphanumeric `[A-Za-z0-9]` | 62^10 ≈ 8.39×10^17 | 59.5 | ≈8.4×10^11× |
| 10 chars `[a-z0-9]` | 36^10 ≈ 3.66×10^15 | 51.7 | ≈3.7×10^9× |

The alphabet was not published, so both cases are shown; either way it is a 31–39 bit increase.

Now the correction that most coverage skips. **A short code's security comes from the online attempt budget, not the key space.** Six digits with a limit of ten attempts per hour per token and invalidation on repeated failure takes about eleven years to exhaust `10^6`. Ten alphanumeric characters with no rate limit and reusable tokens buys nothing. So the 6-to-10 change is best read as **defense in depth under the assumption that the token has already leaked** — buy headroom on the second factor. Whether 1Password enforces attempt limits, single use, and token-to-code binding is not public, and belongs on the RCA checklist.

One small precision note: the disclosure describes the flow as requiring "a six digit code" in present tense, then describes expanding "six digits to ten characters." Post-change code is ten characters; messages already in flight at disclosure time may still have carried six. Worth reading the two usages separately.

## 3. The chain: when an identity becomes authority

### 3.1 What the disclosure confirms

```
[1] employee corporate GitHub account compromised
      ↓  (read private repositories)
[2] source code access and copy
      ↓  (repo write → pipeline execution)
[3] malicious code pushed to backend services   ← without this step there is no data theft
      ↓  (running with the service's own DB authority)
[4] customer account records downloaded + CI/CD infrastructure secrets reachable
```

What 1Password confirmed is the existence of these four steps. What it did not confirm is **which gate each step passed through, and what was open.** For [3] to happen at all, at least one of these must hold: a push could reach a protected branch without human review, a pipeline could obtain production credentials from an unprotected branch, deployment approval was automatic, or repository write access alone exposed a deploy token. That is precisely the gap The Register flagged.

### 3.2 The controls each step needed

Without an RCA, this is reverse-engineered rather than asserted.

| Step | Required control | Common failure mode |
| :--- | :--- | :--- |
| [1] Account takeover | Phishing-resistant MFA (passkeys), conditional access, device trust, short session lifetime | A personal PAT or OAuth app token bypasses MFA and never expires |
| [2] Repository read | Org-wide least privilege, per-repo scoping, secret scanning | A developer account can read every private repo in the org |
| [3] Deploy | Protected branches + required review + CODEOWNERS, environment protection with manual approval, deploys only from a dedicated service account or OIDC short-lived token | A human push is a production change; protection bypasses go unlogged |
| [4] Data | No bulk reads on the request path, separate admin plane, row-count alerting, egress restriction | The customer-facing service account can iterate every customer record |

[3] and [4] are the substance. [1] is an initial compromise that any organization can suffer. The problem is that [1] reached [4] through [3], and that distance is determined by **whether the identity layer and the deployment layer were wired together with the same credential**.

One structural point worth internalizing: CI/CD credentials are a different category of asset. A source code leak is an intellectual property problem. A pipeline credential leak is an **authority** problem, because pipelines exist to authenticate to cloud accounts, registries, and production APIs. An attacker who can modify a pipeline does not need to find a vulnerability in the product — they ask the product's own deployment system to run their code. That is why 1Password called out CI/CD separately and moved on rotating infrastructure secrets.

### 3.3 What defenders can actually look at

There are no hashes, domains or IPs in the disclosure, and that is expected: this is a credential compromise, not a product flaw, so there is no scanning surface. The indicators live in behavior.

- **GitHub organization audit log**: `git.push` at unusual hours, new `personal_access_token.create` / `deploy_key.create` / GitHub App installations, `protected_branch.policy_override`, changes under `.github/workflows/*`, org membership or role changes. If audit log streaming is not already wired to a SIEM, there is nothing to reconstruct afterward.
- **1Password admin audit log**: sign-ins from new devices or locations, abnormal spikes in invitation and recovery events, reactivation of deprovisioned accounts.
- **User-side signal**: emails impersonating 1Password about invitations or recovery. The leaked records include name, login email and last sign-in time, which is exactly enough to make "we noticed a new device sign-in on November 24" look like a fact. That combination, not the verifier, is what makes the stolen records dangerous.

## 4. Mitigation, in the order it matters

### 4.1 For 1Password users

- **No password or Secret Key change is required**, per 1Password. The reasoning holds: vault data was not exfiltrated in a usable form, and the verifier cannot be attacked without the Secret Key. A voluntary rotation is not forbidden either — changing the password produces a new `x` and `v` and invalidates the leaked verifier.
- Check the device list and 2FA state. Any unfamiliar device means revoke sessions and reset.
- Treat every unsolicited 1Password invitation or recovery email as hostile. 1Password does not ask for account passwords or Secret Keys by mail or phone. The Secret Key is entered into the app only on a new device's first sign-in.
- Navigate to the site yourself instead of clicking a link in mail. This is the one habit that defeats the phishing wave that follows this class of breach.

### 4.2 For organizations: treat GitHub identity as a production credential

1. **Stop letting human accounts deploy.** Deploy from a dedicated GitHub App or service account, only from a protected branch, using OIDC-issued short-lived tokens. No static cloud keys in pipeline secrets.
2. **Require human approval on the production environment.** Required reviewers, a wait timer, and deployment branch restrictions. A deploy that runs without approval is itself an alert.
3. **Alert on protection bypasses.** Promote `protected_branch.policy_override`, admin pushes, and review-dismissed merges to paging. Having a rule and having evidence it was followed are different facts.
4. **Govern token lifetime and scope mechanically.** Fine-grained PATs under 90 days, repository-scoped, auto-revoked when unused. Periodically enumerate org-owned PATs and force owner confirmation.
5. **Attach provenance to build artifacts.** Signed commits plus build attestation are the only way to answer "is the artifact we shipped the code in the repository" after a repository is contaminated. Without them, that question is unanswerable — and it is the question every customer of a breached vendor asks.
6. **Restrict runner egress.** A build runner that can reach the whole internet makes any injected pipeline code an exfiltration path on its own. Allow-list egress and a package registry mirror should be defaults.

### 4.3 The data plane: shrink what a service can read

The fact that planting code in the backend sufficed to walk off with customer records says the authority between code and data was very wide. A service account should read **what one request needs**. Administrative and back-office reads belong on a separate plane, gated by human approval and session recording. Row-count thresholds on queries separate normal traffic from bulk extraction. None of this prevents compromise; **it prevents compromise from becoming disclosure.**

### 4.4 Four questions for the RCA

1. How was the employee's GitHub account taken — phishing, session token theft, OAuth app consent, or device compromise — and was phishing-resistant MFA in place?
2. Which gates did the push pass — branch protection, review, environment approval: which was missing or bypassed?
3. Were CI/CD secrets actually used? Rotation is prevention, not evidence. Did cloud audit logs answer this?
4. Was encrypted vault data downloaded? That is the outstanding half of the community's "no evidence / still underway" pair.

Until those are answered, two things in this case are certain. **Cryptography is what kept the vaults shut. Identity is what opened the road to them.**

---

*Originally published in Korean at [dohyeontech.github.io](https://dohyeontech.github.io/posts/1password-github-cicd-backend-breach/). Primary sources: 1Password disclosure (2026-11-25), 1Password community thread, 1Password's SRP developer post (2018), BleepingComputer, SecurityWeek, The Hacker News, The Register.*
