---
title: "Real URLs, Synthetic Pages: Inside Chrome's Mirror Dimension"
subtitle: "How Chrome's AI Security team built a fake web that a browser agent cannot tell apart from the real one"
canonical_url: "https://dohyeontech.github.io/posts/chrome-mirror-dimension-agent-security/"
cover_image: "https://dohyeontech.github.io/assets/images/thumb_chrome_mirror_dimension.png"
tags: [ai, security, webdev, mcp]
source_ko: "https://dohyeontech.github.io/posts/chrome-mirror-dimension-agent-security/"
---

On 19 November 2026 at 17:00 UTC, Google's security blog published a post from Chrome's AI Security team, written by Aaron Selya and Charles Qian. There is no CVE, no list of affected versions, no patch diff, no remediation deadline. It opens with a different claim: Chrome already ships agentic browsing (`auto browse`), and to test the defenses around it the team built a synthetic replica of the web. They call it the mirror dimension.

When security people read a vendor blog, they usually look for vulnerability detail. This post sits on the other side of that. It does not describe the product being attacked; it describes the infrastructure for attacking it. Indirect prompt injection has been ranked the top threat to browser agents for some time, and very few organizations can actually exercise defenses against it. Reading how an evaluation harness was built shows where defenses have been tested and where they have not. That is the part worth keeping.

## 1. Why an agent cannot be turned loose on the open web

The example request in the original post: "go to my YouTube account and download the latest episode of the Made By Google podcast so I can watch it on the plane today." The user gives no URL. The model infers the destination and plans a navigation to `www.youtube.com`. Evaluation breaks down right there, because real users do not hand over addresses and test harnesses are usually built as if they do.

The scale requirement is no easier. Training and evaluation need thousands of read and write actions across hundreds of websites, continuously. Using the open web is wrong in two directions. The web keeps changing, so results are not reproducible. And an agent with no constraints can do real damage. The post's own wording: evaluation has to be safe, reliable and repeatable, the side effects of one trajectory must never carry into the next, and every run has to start from a clean, identical baseline.

Write actions add a third problem. Items land in carts, coupons get burned, payments go through, posts appear in feeds. If that state survives into the next run, both reproducibility and isolation break at once — and leftover state also reads to the agent as a signal that this is a test. The post says the synthetic sites have to cover local service marketplaces, e-commerce checkout, social feeds and recipe sites. That means maintaining hundreds of pages that hold state.

| Requirement | Open web | Static mockups | What is actually needed |
|---|---|---|---|
| Reproducibility | Content keeps changing | Fixed but shallow | Per-run baseline snapshot |
| Safety | Real payments, posts, sends | None | Isolation boundary plus blocked side effects |
| Realism | Maximum | Agent notices it is a test | Real URLs, real state, multi-page flows |
| Coverage | Unlimited | A few hand-built pages | A generation pipeline |

Those four constraints drive the rest of the post. Build isolation for reproducibility and safety, and realism collapses; get realism back, and the agent notices the test. The mirror dimension is an attempt to satisfy all four at once, and half the post is a record of the failures on the way.

## 2. A proxy that keeps the real URL

The first attempt was the obvious one: host every synthetic site as a path under a single domain.

```text
https://fake-sandbox-sites.web.app/evals/www.youtube.com
```

The URL itself is a test marker. The next idea is to name that address in the evaluation prompt — which the post says breaks realism and invites **eval awareness**, the model realizing it is being tested. That leaves one option: let the agent navigate to the real URL and intercept the request underneath it.

The structure: the agent opens pages in headless Chrome inside an isolated **gVisor sandbox**. Requests never reach external DNS or the public internet. The sandbox captures the network connection, routes it to a local proxy, and the proxy serves the generated synthetic site. `https://www.youtube.com` stays in the address bar.

gVisor was chosen for structural reasons. It is an **application kernel** that implements a Linux-like interface, written in memory-safe Go and running in user space — not a syscall filter, and not a VM in the usual sense. It is aimed squarely at the fact that a container is not a sandbox: containers share the kernel, so a single vulnerability can be an escape. In a scenario where a successfully injected agent moves on to a kernel exploit, meeting a Go user-space kernel instead of the host kernel is not a side benefit. The point of this environment is to hold a compromised agent.

Then comes the harder part. Intercepting a connection is exactly the person-in-the-middle that Chrome is designed to block for users. Without cryptographic proof of the proxy's identity, every request dies with a fatal TLS error; downgrade to plaintext HTTP and the browser shows `Not Secure`. The post acknowledges this is "the very kind of interception Chrome is designed to block," and gives the answer:

The proxy **mints TLS leaf certificates on the fly**, and the chain terminates at a **custom root CA preinstalled in the sandbox's Chrome**. The vendor's argument: on a real user device, planting a custom root CA requires admin rights on that machine already. A gVisor sandbox is entirely under our control, so the trust anchor can be set at startup.

```text
[agent] https://www.youtube.com   (address bar and DOM both show the real value)
    │
    ├─ netstack: no external DNS, no public internet
    │
    ├─ proxy: reads SNI / hostname → issues a leaf certificate on the fly
    │            └─ chain: local root CA (injected at sandbox boot)
    │
    └─ synthetic web server: reads X-Sandbox-Injection-Key, returns mutated page
```

> Author's note: the post stops at "capture the connection and route it to the proxy." DNS synthesis and routing changes in the diagram are the natural implementation shape of gVisor keeping its network stack in user space, not vendor-published code.

From here, my reading. The justification does not rest on the fact that a root CA is installed; it rests on the **scope of that trust anchor closing inside one sandbox**. On a real device the same act hands over the user's entire TLS trust. In the sandbox it is valid only for the hostnames that Chrome instance can see. But one property changes: that CA's private key becomes the **master key for every hostname** inside the sandbox. The threat this creates is therefore not host compromise but **evaluation integrity**. The key has to sit outside the agent's reachable paths (filesystem, loopback services), issuance has to be bound to a hostname allowlist and a time window, and the whole thing has to die with the sandbox. Break any of that and a successfully injected agent can mint its own certificates for other sites and pass "normally."

## 3. Fighting eval awareness: from query parameter to HTTP header

Injecting the attack is the next problem. The first implementation used a URL parameter.

```text
https://www.youtube.com/watch?v=dQw4w9WgXcQ&prompt_inject_payload=abcd1234
```

Frontier models caught it. In the post's words, many of them realized they were being tested simply by finding an abnormal query parameter that would never legitimately appear on that site. That is not a story about model sensitivity; it is a story about an **evaluation design defect**. The test environment was describing itself.

The fix was to change the channel. The payload identifier moves into a **custom HTTP request header**. The orchestration harness fills something like `X-Sandbox-Injection-Key`, the sandbox web server intercepts and strips the header, and serves the mutated page. **The URL the page shows stays completely clean.** The post notes that from the agent's point of view, the page looks like an ordinary website with a realistic URL structure.

Why that choice is correct is the most practical part of the post. A real attacker cannot manipulate request headers. What an attacker controls is **response content**. Carrying the payload in a query parameter was convenient, but it used a channel that does not exist in the real threat model. The change is not a concealment trick; it is **matching the threat model**. That the header sits outside the model's observation range is a side effect. The substance is imitating the scope of an attacker's authority.

Two design advantages follow. The header carries a **pointer**, not the payload itself, so the same key produces the same mutation and reproducibility comes for free. And the technique never lands in plaintext in URLs or proxy access logs — evaluation infrastructure logs leak with some regularity, and a log full of "which sentence broke which model" turns the infrastructure into an attack catalog.

The root problem remains: "does not look like a test" ultimately depends on **what the model perceives**. Make models more perceptive and yesterday's disguise is today's tell. That is why the team's next move was site quality.

## 4. The multi-turn attack surface: DOM, ARIA, images, WebMCP tool responses

The surfaces the post names are not just visible text. What a browser agent perceives spans the **rendered visual layout, the DOM underneath it, and structured tool interaction such as WebMCP**. A payload can hide in any of those layers, at any step of a multi-stage workflow.

Controlling the entire synthetic web server means those layers can be manipulated programmatically: injecting through images or text, adding malicious ARIA labels, and **mutating WebMCP tool responses in real time**. The post calls the result "a dynamic testbed for multi-vector adversarial stress tests over multi-turn trajectories."

WebMCP deserves a note. It is a proposal standard for web applications to declare tools for agents. A page registers tools such as `checkout` or `filter_results`, states inputs and outputs in JSON Schema, and shares the current page state. It is gated by the `tools` Permissions Policy, defaults to `self`, and needs `allow="tools"` for a cross-origin iframe. Per Chrome's documentation, the origin trial has been open since Chrome 149.

The reason this layer is dangerous for agent designers is that the trust direction flips. Screen text is content models are trained to treat as suspicious. A value returned by a tool that conforms to a JSON schema reads as **structured system output**. An injection sitting in the `description` field of a `tool_result` gets less scrutiny than the same sentence sitting in a text node. That the mirror dimension includes tool-response mutation as an evaluation item means this path was classified as a surface to test, not a theoretical concern.

Multi-turn raises the difficulty again. A single-page check asks "does this page contain an attack sentence?" In a multi-turn trajectory, an instruction planted at step 3 fires at the payment confirmation in step 7. You have to trace how a tainted value crosses from one step into the next step's context, and without that trace a page-by-page check can pass everything while the trajectory as a whole is wide open.

## 5. The agent team that builds the sites: research, builder, critic

Meeting the realism requirement by hand is impossible. The post says agents spot half-built sites quickly. So site generation itself was handed to a **multi-agent harness**. A human defines only the high-level user journey (CUJ) to be tested; underneath, three roles design, implement, review and critique inside the sandbox.

The **research agent** turns a user prompt into a site spec. For e-commerce it enumerates catalogue filtering, cart persistence, coupon validation and multi-step checkout, and fills in whatever the user did not specify. It sets the site architecture and related CUJs, and produces baseline UI assets with **Nano Banana**. The **builder agent** translates the spec into HTML, CSS and JavaScript, including responsive layout and the multi-page navigation a long trajectory needs. The **critic agent** evaluates the result against production web benchmarks: whether accessibility-tree semantics (ARIA roles and labels) behave as intended, whether form validation catches edge cases, whether the console is free of JavaScript errors, and whether element bounds and layouts render correctly at different viewport sizes.

How they look at a site matters. They do not read source as text; they use **Chrome DevTools for Agents (MCP)** to take screenshots, send real clicks and keystrokes, and observe live behavior while navigating. That MCP server is published as Apache-2.0 open source, runs on puppeteer, and exposes network requests, screenshots, console messages and performance traces. The design goal is to let the agents use their multimodal capability directly.

There is a moment in the demo the post specifically points to: **one fix creating a new problem**. It is why there are several layers of critic, and where the line about prioritizing **fidelity over speed of completion** comes from.

My reading: what this loop targets is not accuracy but **false negatives in evaluation**. When an agent looks injection-resistant on a sloppy site, it may not have blocked the injection at all — it may simply distrust the site and behave differently than usual. That is not a safe agent; it is an unmeasurable one. In security evaluation a false negative is more expensive than a false positive. A false positive costs investigation time. A false negative makes you conclude "safe."

There is an irony here. Site quality is judged by a model too. The critic's "production-grade" is a model judgment, and its standard leans on benchmarks humans defined. The evaluation instrument carries the same class of trust problem as its subject. The post does not treat that as a problem; multiple critics catching different errors reads as a practical compromise against single-judge bias.

## 6. What the 1,000-a-day figure actually moved

The numbers in the post: a security engineer can realistically build and test **dozens** of attacks a day by hand, and validating and refining each idea is an immediate bottleneck. The automated pipeline produces **more than 1,000 test candidates per engineer per day** on top of the mirror dimension. More than **30 times** manual output — in the post's phrasing, "a month of manual work every day."

| | Manual | Pipeline |
|---|---|---|
| Candidates | Dozens per day | 1,000+ per engineer per day |
| Bottleneck | Validating and refining ideas | Triaging candidates, judging novelty |
| Where the human sits | Generation and evaluation | Technique ideation (upstream) |
| Regression testing | Practically impossible | Possible by replaying trajectories |

Read that table precisely. The post says the pipeline **"tests and improves on our best engineers' ideas."** It does not say it discovers new attack techniques autonomously. Humans invent techniques upstream; automation varies and evaluates those ideas across many sites downstream. Without that division of labor, 1,000 candidates is just 1,000 pieces of noise.

So the bottleneck that actually moved is the one from generation to **triage**. At 1,000 a day the open questions are three. Is this candidate different from existing ones (novelty)? Did the injection actually reach the agent's decision (validity)? And is it worth keeping in the regression suite (reusability)? Judging validity requires instrumentation: which header key served which mutation, which DOM node or tool response it landed in, and what the agent did afterwards, all correlated inside one trajectory. Full control of the sandbox web server is also what makes that correlation possible.

## 7. What is left for defenders: layered defense and a harness checklist

To see what the mirror dimension is testing, look at the defenses Chrome has in place. A December 2025 post from the Chrome security team names indirect prompt injection as the top threat to agentic browsing and describes a layered structure mixing deterministic and probabilistic defenses.

- **User Alignment Critic.** After planning, a separate model reviews each proposed action. It never sees **raw untrusted web content — only action metadata.** Placing it where the web cannot poison it is the point. The post cites the dual-LLM pattern and DeepMind's CaMeL research.
- **Agent Origin Sets.** For each task, read-only origins and read-write origins are tracked separately. Content from an iframe not in the read set **never reaches the model at all.** The gating function that computes the origin sets is likewise not exposed to untrusted content, and URLs the model produces are restricted to known public URLs by a deterministic check.
- **Sensitive-action confirmation and transparency.** Ask the user before navigating to sensitive sites such as banking or healthcare, expose each step in an action log, and allow interruption at any point.
- **Spotlighting and training.** Steer the model to prioritize user and system instructions over page content, and fold known attacks into training.

Overlay those four on the mirror dimension's surfaces and the mapping appears. WebMCP tool-response mutation targets the path that trusts structured system output. ARIA-label and image injection target perception channels the model does not classify as untrusted. Multi-turn trajectories test whether origin gating and per-action critics break **between** steps. In other words, the mirror dimension reads the list of defense layers and places attacks against each item on it.

For people building agents, the design conditions this post yields are roughly these.

| Area | Check | What breaks if it fails |
|---|---|---|
| Trust anchor | Is the root CA's scope closed inside one sandbox? | Loss of evaluation integrity (self-issued bypass) |
| Key custody | Is the key outside the agent's reachable paths? | Injection becomes certificate forgery |
| State reset | Per-run snapshot, fixed seed, baseline copy | Cross-run contamination, test detection |
| Payload channel | Is it a channel the model cannot observe? | Higher test-awareness rate, contaminated measurement |
| Instrumentation | Can payloads be correlated with actions? | No validity judgment, noise accumulates |
| Metrics | Is injection success rate reported alone? | False negatives read as safety |

The last row is the most frequently ignored. Report only the attack success rate (ASR) and a site too crude to be believed gets counted as "defense success." Measure at least the **test-awareness rate** alongside it: count the share of trajectories where the model recognized the test, and compute success only over the ones where it did not. Placed together, the two numbers separate "the disguise leaks, so the test escapes" from "the defense is weak, so it breaks."

## 8. What this architecture cannot validate

Start with what the post withholds: site count, models used, size of the payload catalog, decision thresholds. No code, no paper. That is expected for internal infrastructure, but it means the post alone cannot be reproduced. The numbers are not consistent in one place either. The introduction says "thousands of simulated websites"; past the site-generation section the phrase becomes "hundreds of interactive, stateful web pages." Corpus size is better read as a range than as a single figure.

There is a more structural limit. If site creation is model-driven, the **ceiling on evaluation coverage is the generator's imagination**. UI patterns the generator cannot produce, and CUJs the team never defined, go untested. However dense the critic, it cannot catch "a surface this site does not have." And a sandbox is not a real device: the surfaces created by extensions, logged-in sessions, real payments and MFA, and user data all live outside it. That is why the post keeps realism on the open-items list.

Eval awareness is something to lower, not eliminate. Some difference between "this is a test" and reality always remains, and more perceptive models see it more clearly. The architecture evolved once in the direction of shrinking it; the post does not claim it closed it. Extension to coding agents appears only as a plan. The web primitives and tool calls a browser handles are comparatively narrow; a coding agent's toolset is far wider and its side effects larger. There is no basis yet to claim the same sandbox covers it.

One point deserves saying plainly. This post contains no CVE, no exploitation in the wild, no breach. The threat it discusses is not a breach that happened but one that **could happen**, which is why its value sits in design documentation rather than incident reporting. What a team putting a browser agent into a product should take from it is not a list of attack strings, but a procedure for checking whether its own evaluation environment is describing itself. The most practical passage is not the architecture diagram. It is that the authors chose to put a shot of one fix creating a new problem into a public demo. Only a team that can show that is in a position to doubt its own false negatives.

*Originally published in Korean at [dohyeontech.github.io](https://dohyeontech.github.io/posts/chrome-mirror-dimension-agent-security/).*
