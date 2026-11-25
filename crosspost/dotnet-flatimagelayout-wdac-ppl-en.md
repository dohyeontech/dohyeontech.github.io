---
title: "One Bit Was Enough: How .NET's Image Loader Walked Past WDAC, PPL, and VirtualBox Hardening"
subtitle: "Clearing IMAGE_FILE_EXECUTABLE_IMAGE in a PE header makes Windows refuse to map the file as an image while .NET Framework 4 still executes it from a plain data section, where no integrity hook is watching. Project Zero used that one behaviour against VirtualBox (CVE-2026-87268), Windows 11 S Mode (CVE-2026-108398), and a PPL process that still has no CVE at all."
canonical_url: "https://dohyeontech.github.io/posts/dotnet-flatimagelayout-wdac-ppl/"
cover_image: "https://dohyeontech.github.io/assets/images/thumb_dotnet_singlebit_en.png"
tags: [security, windows, dotnet, virtualization]
source_ko: "https://dohyeontech.github.io/posts/dotnet-flatimagelayout-wdac-ppl/"
---

*This is the English adaptation of the original Korean analysis at [dohyeontech.github.io](https://dohyeontech.github.io/posts/dotnet-flatimagelayout-wdac-ppl/).*

On 7 September 2026, a commit landed in the VirtualBox repository with 25 added lines and 5 removed. The functional change was a single `return`: a function that answered `VERR_LDR_ARCH_MISMATCH` with `STATUS_INVALID_IMAGE_FORMAT` now answers `STATUS_FILE_NOT_SUPPORTED`. The commit message explains why in one sentence — do not return `STATUS_INVALID_IMAGE_FORMAT` from `NtCreateSection`, because it confuses .NET.

The fix is that small because the defect was a status code. Explaining what the status code unlocked takes you through the .NET runtime's PE loading path, the Windows Lockdown Policy flag comparison, VirtualBox's DLL loader hooks, and the signature requirements of protected processes. James Forshaw's Project Zero write-up, published on 23 November 2026 as *"VirtualBox Process Hardening on Windows 2026 Edition: What's a Single Bit Between Friends?"*, walks the whole route. This article reconciles that write-up with the two vendors' fix commits, the NVD, MSRC and Oracle records, and the CISA KEV catalog. Nothing here was reproduced; the code excerpts and diffs are the ones the primary sources published.

## 1. What broke, and what did not

Start with scale. This is not remote code execution against Windows. The attacker must already be logged in to the host as a low-privileged user, and needs "a program willing to load an assembly". The VirtualBox issue is not a guest-to-host escape either; it is a local user on the host pushing code into the VM process. Those limits matter because the real weight of the finding is not what an attacker can run, but what the defences never inspect.

Three separate barriers fell to one mechanism.

| | CVE-2026-87268 (VirtualBox) | CVE-2026-108398 (.NET Framework) |
| :--- | :--- | :--- |
| Target | VirtualBox 7.2.16 on Windows hosts | .NET Framework 4 on Windows |
| Score | **7.8** (Oracle, High) | **8.8** (Microsoft, Important, temporal 7.7) |
| Fixed | 2026-09-15 CPU, build **7.2.18** (current 7.2.22) | 2026-10-13 cumulative update, **per-OS KB** |
| NVD | Published 2026-09-15, `Analyzed`, CWE-269 | Published 2026-10-13, `Awaiting Analysis`, CWE-426 |
| Exploitation | No known exploitation | `exploited: No`, `publicly disclosed: Yes`, `Exploitation Less Likely` |
| KEV | Not listed (catalog 2026.11.24, 1,795 entries) | Not listed |

The score difference is scope. VirtualBox is `AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H`; .NET is `AV:L/AC:L/PR:L/UI:N/S:C/C:H/I:H/A:H`. Same preconditions — local, low privilege, no user interaction — but Microsoft rated the impact as crossing into another security authority, which is what a protected process is.

The third barrier has no CVE. **PPL (Protected Process Light)** was bypassed by the same loading behaviour, and Microsoft keeps PPL bypasses outside its servicing criteria. The October fix corrected the UMCI policy check only; loading for protected processes was not changed. Forshaw's conclusion is that the PPL route should still work. Two CVEs have patches. The third has none.

None of the three appears in CISA KEV. I re-pulled the catalog on 25 November 2026 at 13:00 KST: `catalogVersion 2026.11.24`, 1,795 entries, zero additions dated 2026-11-25. NVD's CISA SSVC records also say `exploitation: none` (2026-09-21 for the VirtualBox issue, 2026-10-13 for the .NET one). As of writing, there is no public evidence of use in attacks. The proof of concept sits in the Project Zero issue tracker.

A timeline helps.

| Date | Event |
| :--- | :--- |
| 2026-08-20 | A warning comment enters the VirtualBox tree: translating this error to `ERROR_BAD_EXE_FORMAT` sends .NET down an unsafe fallback |
| 2026-09-07 | VirtualBox fix commit `167339cf` changes the returned status |
| 2026-09-11 | Second commit `d305b076` stops COM from consulting HKCU class registrations |
| 2026-09-15 | Oracle September CPU ships VirtualBox 7.2.18; CVE-2026-87268 is published |
| Mid Sept 2026 | Forshaw presents the Windows code-integrity bypass at 44Con |
| Late Sept 2026 | .NET developers ask him to report it; because it was already public, MSRC treats it as a zero-day |
| 2026-10-13 | .NET Framework cumulative update fixes CVE-2026-108398 |
| 2026-11-23 | Project Zero publishes the write-up |
| 2026-11-24 | The Hacker News covers it |

## 2. Two ways into the loader, one of them guarded

### 2.1 PEImageLayout::Map

The function at the centre of assembly file loading in the .NET Framework 4 runtime (`CLR.DLL`) looks roughly like this in the write-up.

```cpp
PEImageLayout *PEImageLayout::Map(HANDLE file) {
  PEImageLayout* image = new MappedImageLayout(file);
  if (!image->Image) {
    image = new FlatImageLayout(file);
  }
  if (image->Image) {
    if (!PEDecoder::CheckFormat(image->Image))
       ThrowWin32(ERROR_BAD_EXE_FORMAT);
  }
  return image;
}
```

Two layouts, as the names suggest. `MappedImageLayout` maps the file as an image section; `FlatImageLayout` maps it as a data section. The first constructor carries both the interesting flag and the interesting failure handler.

```cpp
void MappedImageLayout::MappedImageLayout(HANDLE file) {
  HANDLE mapping = CreateFileMapping(file, nullptr, SEC_IMAGE | PAGE_READONLY);
  if (mapping) {
    this->Image = CLRMapViewOfFileEx(mapping);
  } else {
    if (GetLastError() != ERROR_BAD_EXE_FORMAT)
      ThrowLastError();
  }

  DWORD policy = 0;
  if (EEConfig::EnforceCodeIntegrity()
   || (SUCCEEDED(WldpGetLockdownPolicy(nullptr, &policy, nullptr))
   && !WLDP_LOCKDOWN_IS_OFF(policy) && !WLDP_LOCKDOWN_IS_CONFIG_CI(policy))
  ) {
     ThrowWin32(ERROR_BAD_EXE_FORMAT);
  }
  // ...
}
```

`SEC_IMAGE` is what gives the ecosystem a place to intervene: the kernel parses the file as a PE image, builds an image section, and image-signature or location checks — VirtualBox's loader hooks, code integrity — get their notification. Then there is the failure path. If `CreateFileMapping` fails with anything other than `ERROR_BAD_EXE_FORMAT`, the load aborts. If it fails with exactly that error, the constructor simply leaves `Image` null and the caller falls through.

The fallback is plain.

```cpp
void FlatImageLayout::FlatImageLayout(HANDLE file) {
  HANDLE mapping = CreateFileMapping(file, nullptr, PAGE_READONLY);
  if (mapping) {
    this->Image = CLRMapViewOfFileEx(mapping);
  } else {
    ThrowLastError();
  }
  // ...
}
```

No `SEC_IMAGE`, no executable pages, no hook. .NET does not need executable pages for this: IL is JIT-compiled into separate executable memory, and the data mapping is only the source of metadata and IL bytes. A file that could not be mapped as an image still runs. `PEDecoder::CheckFormat` at the end validates PE structure, not the authority of the file, and it ignores which header bits were changed.

The broken invariant is not a memory-safety property. It is the assumption that *code that executes must have passed through an image-section mapping*. VirtualBox hardening and Windows code integrity both attach their checks to the question "was an image or executable mapping requested?" The fallback never asks it, so any structurally valid assembly executes without inspection.

### 2.2 Why the WLDP check let UMCI through

The WLDP check inside `MappedImageLayout` was meant to stop here when code integrity is enforced (`EEConfig::EnforceCodeIntegrity()`) or when `WldpGetLockdownPolicy` returns a policy that is neither off nor "CONFIG_CI". The defect is in how the second condition compares.

`WLDP_LOCKDOWN_CONFIG_CI` is not a single bit; per the write-up it is the combination `DEFINED | CONFIG_CI | UMCIENFORCE`. That is exactly what `WldpGetLockdownPolicy` returns on Windows 11 S Mode. The check asked whether the policy equals a known preset, S Mode returned that preset, `!WLDP_LOCKDOWN_IS_CONFIG_CI(policy)` evaluated false, and loading continued with UMCI enabled. The intended question was "is UMCI being enforced?" The question actually asked was "does the policy value exactly match this one constant?"

Microsoft's fix is one line.

```cpp
  if (EEConfig::EnforceCodeIntegrity()
   || (SUCCEEDED(WldpGetLockdownPolicy(nullptr, &policy, nullptr))
   && !WLDP_LOCKDOWN_IS_OFF(policy) && WLDP_LOCKDOWN_IS_ENFORCE(policy))
  ) {
     ThrowWin32(ERROR_BAD_EXE_FORMAT);
  }
```

`WLDP_LOCKDOWN_IS_ENFORCE` checks for UMCI enforcement directly. This closes the UMCI path and deliberately leaves protected-process loading alone.

### 2.3 How VirtualBox manufactured the fallback

On Windows hosts, VirtualBox protects its VM processes from the logged-in user by hooking the DLL loader. One of those hooks is `supR3HardenedMonitor_NtCreateSection`.

```cpp
NTSTATUS supR3HardenedMonitor_NtCreateSection(PHANDLE phSection,
                                     ACCESS_MASK fAccess, POBJECT_ATTRIBUTES pObjAttribs,
                                     PLARGE_INTEGER pcbSection, ULONG fProtect,
                                     ULONG fAttribs, HANDLE hFile) {
  bool const fExecProt = (fProtect &
         (PAGE_EXECUTE | PAGE_EXECUTE_READ | PAGE_EXECUTE_WRITECOPY |
          PAGE_EXECUTE_READWRITE)) != 0;
  if (hFile != NULL && hFile != INVALID_HANDLE_VALUE) {
    bool const fImage    = RT_BOOL(fAttribs & (SEC_IMAGE | SEC_PROTECTED_IMAGE));
    bool const fExecMap  = RT_BOOL(fAccess & SECTION_MAP_EXECUTE);
    if (fImage || fExecMap || fExecProt) {
      bool fCallRealApi;
      NTSTATUS rcNt = supR3HardenedScreenImage(hFile, fImage,
                          true /*fIgnoreArch*/, &fAccess, &fProtect,
                          &fCallRealApi, "NtCreateSection",
                          true /*fAvoidWinVerifyTrust*/, NULL /*pfQuiet*/);
      if (!NT_SUCCESS(rcNt))
        return rcNt;
      if (!fCallRealApi)
        return STATUS_TRUST_FAILURE;
    }
  }
  // ... original NtCreateSection
```

The screen runs only when the request asks for an image, an executable mapping, or executable protection. `FlatImageLayout`'s `CreateFileMapping(file, nullptr, PAGE_READONLY)` asks for none of those. The fallback does not even touch the hook.

For the fallback to happen, `CreateFileMapping` has to fail with `ERROR_BAD_EXE_FORMAT`, which happens when `NtCreateSection` returns `STATUS_INVALID_IMAGE_FORMAT`. VirtualBox produces that status in exactly one place.

```cpp
static NTSTATUS supR3HardenedScreenImageCalcStatus(int rc) {
    if (rc == VERR_LDR_ARCH_MISMATCH)
        return STATUS_INVALID_IMAGE_FORMAT;

    return STATUS_TRUST_FAILURE;
}
```

`VERR_LDR_ARCH_MISMATCH` comes from VirtualBox's PE parser (`rtldrPEOpen`, reached through `RTLdrOpenWithReader`) when a file's architecture does not match the host and the file contains executable sections. That is where `AnyCPU` becomes decisive. A managed-only assembly compiled as `AnyCPU` is a 32-bit x86 PE, and even with pure IL the optional header's `size of code` is non-zero. The `dumpbin /headers` output in the write-up shows it.

```
FILE HEADER VALUES
             14C machine (x86)
               3 number of sections
        D62E716A time date stamp
               0 file pointer to symbol table
               0 number of symbols
              E0 size of optional header
            2022 characteristics
                   Executable
                   Application can handle large (>2GB) addresses
                   DLL

OPTIONAL HEADER VALUES
             10B magic # (PE32)
           48.00 linker version
          35CC00 size of code
             600 size of initialized data
               0 size of uninitialized data
```

`characteristics 2022` is `IMAGE_FILE_EXECUTABLE_IMAGE (0x0002)` plus `IMAGE_FILE_LARGE_ADDRESS_AWARE (0x0020)` plus `IMAGE_FILE_DLL (0x2000)`. On a 64-bit host, mapping that 32-bit PE as an image gives an architecture mismatch, and because the file has code sections, the parser returns `VERR_LDR_ARCH_MISMATCH`. The chain follows: `STATUS_INVALID_IMAGE_FORMAT`, then `ERROR_BAD_EXE_FORMAT`, then the fallback. **Without modifying a single byte of the assembly**, it passes VirtualBox's image screening.

The last piece is getting the assembly loaded by the hardened process as an assembly, not through `LoadLibrary`. The write-up uses COM hijacking: write a registration for a class that a hardened VirtualBox process loads at startup into the current-user hive (HKCU), start a VM, and the process instantiates the COM object, brings up the .NET runtime, and the runtime reads the attacker's assembly through `FlatImageLayout`.

## 3. The exploit chain

### 3.1 Windows: one bit and regasm

Without a VirtualBox hook, `NtCreateSection` itself has to fail. The condition Forshaw found is clearing `IMAGE_FILE_EXECUTABLE_IMAGE` (0x0002) in the COFF file header's `Characteristics`. Windows then refuses the file as an image section, while .NET, which does not use that bit to decide loadability, still accepts it as an assembly. No checksum repair is needed. In the write-up's words, a hex editor is enough.

To trigger the load, use an in-box .NET tool that takes an assembly path. Give the assembly a `[ComUnregisterFunction]` and pass the modified DLL to `regasm.exe` with `/unregister`.

```
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\regasm.exe c:\path\to\assembly.dll /unregister
```

`/unregister` does not require administrator rights, and the unregistration path calls the developer-supplied `UnregisterFunction`. The write-up states that this executed code on Windows 11 S Mode with UMCI enabled — "in theory this should have failed, but it didn't" — which points straight back at the WLDP comparison in §2.2.

The prerequisites are real: code execution on the host as a low-privileged user, and a program willing to load an assembly. `regasm.exe` is a signed Microsoft binary that accepts a user-writable path, which produces the familiar shape of "an application-control-approved tool running code the policy does not allow."

### 3.2 PPL: TCB-level code without administrator rights

PPL is a process class ordinary programs cannot enter even with administrator rights. Forshaw hijacked a COM object that `WerSecureFault.exe` loads at runtime and ran a modified .NET DLL inside that process — "arbitrary code as PPL at the TCB level without needing administrator privileges."

Two details bound the technique. First, the original Protected Process (PP) requires page hashes in the DLL's Authenticode signature, which the .NET runtime DLLs lack, so PP is not reachable this way; only PPL is. Second, on a default installation the WLDP check never enters the picture for protected processes: .NET should verify protected status and does not. The October change to `WLDP_LOCKDOWN_IS_ENFORCE` addresses UMCI loading, not protected-process loading. Hence no CVE and no patch for this route.

### 3.3 What the attacker gets, and what they do not

They get a local user who can already run code on a host, bypassing that host's code-admission policy to run unsigned code at a higher trust level: running unapproved code on an S Mode or WDAC-managed endpoint, planting code inside the VM process on a VirtualBox host, or gaining persistence at PPL level.

They do not get remote execution, guest-to-host escape, or administrator rights. Code running inside a PPL process uses that process's authority; it does not hand over an administrator token. The write-up limits the behaviour to .NET Framework 4 (v3.5 and v2 fail later at `LoadLibrary`), and does not investigate .NET 5 and later.

### 3.4 The evidence is in the log that is missing

Detection does not come from watching for an event, because the image check never ran and no code-integrity block event (3033/3077 family) is emitted. What you can look at is the shape of the load. The following are heuristics I derived from the published mechanism, not vendor IOCs.

- `regasm.exe` or `regsvcs.exe` loading a DLL from a user-writable path with `/unregister` — especially `C:\Users\*\AppData`, `%TEMP%`, or Downloads.
- `VirtualBoxVM.exe` (or the `VirtualBox.exe` that launches it) loading `clr.dll` and then reading an unsigned managed DLL. VirtualBox legitimately uses COM, so this only means something when correlated with HKCU class registrations.
- `HKCU\Software\Classes\CLSID\{...}\InprocServer32` entries pointing at `mscoree.dll`, or carrying `Assembly` / `RuntimeVersion` values that name a managed DLL, for classes loaded by VirtualBox or `WerSecureFault.exe`.
- The file itself: a managed PE missing `0x0002` in the COFF `Characteristics`. The YARA rule below tests only that condition, scoped to 32-bit (PE32) assemblies. Object files and resource-only DLLs can match, so treat it as triage rather than detection.

```yara
rule PE_Managed_No_EXECUTABLE_IMAGE_Triage
{
    meta:
        description = "Managed PE32 whose COFF Characteristics lacks IMAGE_FILE_EXECUTABLE_IMAGE (0x0002)"
        reference = "https://dohyeontech.github.io/posts/dotnet-flatimagelayout-wdac-ppl/"
        confidence = "triage only - verify COM descriptor and managed metadata"
    condition:
        uint16(0) == 0x5A4D and
        uint32(0x3C) < filesize - 0x100 and
        uint32(uint32(0x3C)) == 0x00004550 and
        (uint16(uint32(0x3C) + 22) & 0x0002) == 0 and
        uint32(uint32(0x3C) + 4 + 16 + 208) != 0   // PE32 COM descriptor RVA
}
```

A normal .NET DLL has `characteristics` `0x2022`. A file with managed metadata where only `0x0002` is missing is worth an explanation. Note that the VirtualBox route **does not modify the file at all**, so this rule covers only the Windows code-integrity path.

## 4. The patches

### 4.1 VirtualBox: one status code, plus a COM lookup restriction

The first commit changes the function from §2.3 as follows.

```diff
+       Update 2026-08-20: We should not return anything that can be translated
+       to ERROR_BAD_EXE_FORMAT here, because .NET may take an unsafe fallback
+       path (FlatImageLayout) which maps the file as data and interprets the
+       content without strict certificate checking.
     if (rc == VERR_LDR_ARCH_MISMATCH)
-        return STATUS_INVALID_IMAGE_FORMAT;
+        return STATUS_FILE_NOT_SUPPORTED; /* not STATUS_INVALID_IMAGE_FORMAT!  */
```

The comment is dated 20 August, two weeks before the fix commit — the reasoning was written into the source before the change. The comment even records the follow-up: if other images (resources and the like) break, detect a COM descriptor (CLI header, `BSJB` magic) in IPRT and return a different code for those.

The second commit, `d305b076`, blocks COM's current-user hive lookups.

```diff
+    /* For security reasons, try avoid using KHEY_CURRENT_USER/Software/Classes
+       for anything, only use the HKLM bits. Must be done at once. */
+    IGlobalOptions *pGlobalOptions;
+    HRESULT hrc2 = CoCreateInstance(CLSID_GlobalOptions, NULL, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&pGlobalOptions));
+    if (SUCCEEDED(hrc2))
+    {
+        ULONG_PTR fValue = 0;
+        hrc2 = pGlobalOptions->Query(COMGLB_RO_SETTINGS, &fValue);
+        if (!(fValue & COMGLB_RESERVED4))
+        {
+            fValue |= COMGLB_RESERVED4;
+            hrc2 = pGlobalOptions->Set(COMGLB_RO_SETTINGS, fValue);
```

`COMGLB_RESERVED4` is an undocumented global option; setting it stops COM from consulting HKCU class registrations. The status-code fix removes the fallback; this one narrows the entry point.

On builds: Oracle's September CPU risk matrix lists **7.2.16** as the affected version, Windows hosts only. The VirtualBox changelog dates 7.2.18 to 2026-09-15, and the current release is **7.2.22** (2026-10-20). Anything at or above 7.2.18 carries the fix. The Hacker News table lists 7.2.16 and 7.2.18 together as affected; against the vendor advisory and changelog, 7.2.16 is affected and 7.2.18 is the fixed build. Check `VirtualBoxVM.exe`'s file version on the deployed binary rather than relying on an installer name.

### 4.2 .NET Framework: per-OS KBs

Microsoft's fix is the `WLDP_LOCKDOWN_IS_ENFORCE` line from §2.2, shipped in the 2026-10-13 cumulative updates. The MSRC record is `Important`, 8.8, `exploited: No`, `publicly disclosed: Yes`, `Exploitation Less Likely`, CWE-426 (`Untrusted Search Path`). Its FAQ describes the impact plainly: "An authenticated attacker could place a specially crafted .NET assembly on an affected system and register it for loading by a protected process. Successful exploitation could bypass Windows Defender Application Control restrictions and allow the attacker to execute code within the protected process. User interaction is not required."

The .NET Framework updates are not one package; they are split by OS and framework version. From the 2026-10-13 release notes:

| Windows version | .NET Framework | KB |
| :--- | :--- | :--- |
| Windows 11 26H2 | 3.5, 4.8.1 | **5127694** |
| Windows 11 26H1 | 4.8.1 | 5127691 |
| Windows 11 25H2 / 24H2 | 3.5, 4.8.1 | 5127690 |
| Windows 11 23H2 | 3.5, 4.8.1 | 5127692 |
| Windows Server 2025 | 3.5, 4.8.1 | 5127690 |
| Windows Server 2022 | 3.5, 4.8 / 4.8.1 | 5127687 / 5127693 |
| Windows 10 22H2, 21H2 | 3.5, 4.8 / 4.8.1 | 5127683 / 5127689 |
| Windows 10 1809, Server 2019 | 3.5, 4.7.2 / 4.8 | 5127666 / 5127685 |
| Windows 10 1607, Server 2016 | 4.6.2–4.7.2 / 4.8 | 5126868 (in LCU) / 5127684 |

For 26H2, KB5127694 is titled "October 13, 2026-KB5127694 Cumulative Update for .NET Framework 3.5 and 4.8.1 for Windows 11 26H2" and ships alongside the other 18 .NET security fixes released that day. So the question is not whether a dedicated patch was installed, but whether October's regular servicing was applied. `Get-HotFix -Id KB5127694` only works on the OS whose KB number you guessed; an asset inventory should map the release-notes table per OS instead.

### 4.3 What is left: PPL and policy design

Two fixes did not close everything.

The PPL route remains. October's change corrects the UMCI check and leaves protected-process loading as it was, and the write-up expects that route to keep working. While Microsoft treats PPL bypass as out of scope, expect no CVE and no patch. The practical control is not to block the load but to shrink the entry point: monitor HKCU class registrations for COM classes loaded by protected processes such as `WerSecureFault.exe`, and restrict user-hive COM registration by policy where you can.

WDAC policy semantics matter as much. "We have WDAC" is not a mitigation. Per the write-up, either the `UMCI` or the `Dynamic Code Security` option has to be on. `Dynamic Code Security` is not a default, and it blocks `Assembly::Load(byte[])` as well, so it can break applications. Microsoft's documentation notes that the option supports audit mode only on Windows 11 24H2 and Windows Server 2025 or later; on earlier versions it is enforced even when the policy is in audit mode. Blocked code is logged as event 3114. Organisations running WDAC should re-check two things against this finding: whether their policy enables UMCI, and whether they can enable Dynamic Code Security.

Finally, consider how your own .NET Framework 4 applications load assemblies. Code that reads assemblies from external paths via `Assembly.Load(byte[])` or `Assembly.LoadFrom` is itself the "program willing to load an assembly". After the October patch, the WLDP check sees UMCI correctly, so S Mode and UMCI environments are covered, but environments without UMCI can still reach the fallback. For application developers, the defensive move is to verify the origin and signature of the file before loading it.

## 5. What to carry away

There is no memory corruption here. No heap overflow, no race, no integer wrap. Two things are wrong: the branch that treated `ERROR_BAD_EXE_FORMAT` from `CreateFileMapping` as special, and the condition that compared WLDP flags for exact equality with a preset. On the path those two lines created stood VirtualBox's process hardening, Windows code integrity, and PPL protection — and none of them checked the fact that an assembly mapped as a data section can still execute.

The design question is whether your check looks at the flags on the request or at what ends up executing. A hook that watches only `SEC_IMAGE` requests sees nothing the moment the same file executes through another path. VirtualBox answered that with a status code, Microsoft with a corrected policy expression. PPL has not answered.

---

**Primary sources**: Project Zero, James Forshaw, *"VirtualBox Process Hardening on Windows 2026 Edition: What's a Single Bit Between Friends?"* (2026-11-23) · VirtualBox commits `167339cf659283e7bf465c3c7da32e8a547a528a` (2026-09-07) and `d305b076f67d079378c8439e530a8d95b07180e4` (2026-09-11) · Oracle Critical Security Patch Update, September 2026, CVE-2026-87268 · VirtualBox 7.2 changelog (7.2.18 on 2026-09-15, 7.2.22 on 2026-10-20) · Microsoft MSRC CVE-2026-108398 (2026-10-13, Important 8.8) · .NET Framework October 2026 cumulative update release notes and KB5127694 · NVD CVE-2026-87268 (`Analyzed`, 2026-09-15) and CVE-2026-108398 (`Awaiting Analysis`, 2026-10-13) · CISA KEV catalog 2026.11.24 (1,795 entries; neither CVE listed; checked 2026-11-25 13:00 KST) · CISA SSVC records (both `exploitation: none`) · The Hacker News, *"Google Researcher Shows How a Single Bit Change in .NET Files Bypassed Windows Code Integrity"* (2026-11-24) · Microsoft Learn, App Control for Business and .NET (Dynamic Code Security, event 3114).

Forshaw attached the proof of concept to the Project Zero issue tracker; this article does not reproduce it. The detection heuristics and YARA rule in §3.4 are my own derivation from the published mechanism, not vendor IOCs. Affected versions and fixed builds for CVE-2026-87268 follow Oracle's advisory and changelog, which differ from The Hacker News' table.

*The original Korean version of this report is published at [dohyeontech.github.io](https://dohyeontech.github.io/posts/dotnet-flatimagelayout-wdac-ppl/).*
