---
title: "[분석] 한 비트면 충분했다 — .NET 로더가 WDAC·PPL·VirtualBox를 동시에 지나간 이유"
seo_title: ".NET 한 비트로 WDAC·PPL을 통과한 경로 (CVE-2026-108398)"
slug: dotnet-flatimagelayout-wdac-ppl
date: "2026-11-25"
time: "13:30"
category: "보안 기능 우회"
tags: ["CVE-2026-108398", "CVE-2026-87268", "Project Zero", ".NET Framework", "WDAC", "PPL", "VirtualBox", "CWE-426", "UMCI", "FlatImageLayout"]
thumbnail: /assets/images/thumb_dotnet_singlebit.png
summary: "COFF 헤더의 IMAGE_FILE_EXECUTABLE_IMAGE 한 비트를 지우면 .NET Framework 4는 그 어셈블리를 이미지 섹션이 아니라 데이터 섹션으로 매핑한다. 그 경로에는 코드 무결성 훅이 걸리지 않는다. Project Zero의 James Forshaw는 이 동작 하나로 VirtualBox 프로세스 하드닝(CVE-2026-87268), Windows 11 S Mode의 UMCI(CVE-2026-108398), 그리고 CVE조차 없는 PPL 보호 프로세스를 차례로 통과했다. 두 벤더의 수정은 9월과 10월에 끝났지만, PPL 경로는 연구자 진술 기준으로 아직 열려 있다."
author: "김도현"
---

2026년 9월 7일, VirtualBox 저장소에 들어온 커밋 하나는 diff가 25줄 추가, 5줄 삭제였다. 바뀐 것은 `return` 문 하나와 그 위에 붙은 주석이다. `VERR_LDR_ARCH_MISMATCH`일 때 `STATUS_INVALID_IMAGE_FORMAT`을 돌려주던 함수가 `STATUS_FILE_NOT_SUPPORTED`를 돌려주도록 바뀌었다. 커밋 메시지는 수정 이유를 이렇게 적었다. "NtCreateSection에서 STATUS_INVALID_IMAGE_FORMAT을 반환하지 말 것, .NET이 혼란스러워한다."

수정이 이렇게 작은 이유는, 버그가 상태 코드 하나였기 때문이다. 그런데 그 상태 코드가 무엇을 열어 주는지를 설명하려면 .NET 런타임의 PE 로딩 경로, Windows의 WLDP 정책 플래그 조합, VirtualBox의 DLL 로더 훅, 그리고 PPL 보호 프로세스의 서명 요구사항까지 한 번에 따라가야 한다. Project Zero의 James Forshaw가 11월 23일 공개한 글 "VirtualBox Process Hardening on Windows 2026 Edition: What's a Single Bit Between Friends?"가 그 경로를 전부 지나간다. 이 글은 그 원문과 두 벤더의 수정 커밋, NVD·MSRC·Oracle 레코드, 그리고 CISA KEV를 대조해 정리한 것이다. PoC는 재현하지 않았고, 원문에 있는 코드 인용과 커밋 diff만 근거로 쓴다.

## 1. 무엇이 뚫렸고, 무엇이 뚫리지 않았나

먼저 이 사건의 크기를 정확히 잡아야 한다. 원격에서 Windows를 장악하는 종류가 아니다. 공격자는 이미 그 호스트에 로그인한 저권한 사용자여야 하고, "어셈블리를 로드하려는 프로그램"이 있어야 한다. VirtualBox 쪽도 게스트에서 호스트로 탈출하는 VM escape가 아니다. 호스트의 일반 사용자가 VM 프로세스 안으로 코드를 밀어 넣는 문제다. 원문이 명시한 한계를 먼저 적어 두는 이유는, 이 취약점의 진짜 무게가 "무엇을 실행할 수 있느냐"가 아니라 "무엇을 검사하지 않느냐"에 있기 때문이다.

뚫린 것은 세 개의 서로 다른 방어선이고, 뚫은 수단은 하나다.

| 구분 | CVE-2026-87268 (VirtualBox) | CVE-2026-108398 (.NET Framework) |
| :--- | :--- | :--- |
| 대상 | Windows 호스트의 VirtualBox 7.2.16 | .NET Framework 4 (Windows 전반) |
| 점수 | **7.8** (Oracle, High) | **8.8** (Microsoft, Important, temporal 7.7) |
| 수정 | 2026-09-15 CPU, 빌드 **7.2.18** (현재 최신 7.2.22) | 2026-10-13 누적 업데이트, **OS별 KB** |
| NVD | 2026-09-15 게시, `Analyzed`, CWE-269 | 2026-10-13 게시, `Awaiting Analysis`, CWE-426 |
| 악용 | MSRC/Oracle 악용 정황 없음 | `exploited: No`, `publicly disclosed: Yes`, `Exploitation Less Likely` |
| KEV | 미등재 (2026.11.24 기준 1,795건) | 미등재 |

두 점수의 차이는 scope에 있다. VirtualBox는 `AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H`로 scope가 그대로고, .NET은 `AV:L/AC:L/PR:L/UI:N/S:C/C:H/I:H/A:H`로 scope change가 붙는다. 둘 다 로컬·저권한·사용자 상호작용 없음이라는 같은 전제 위에 있고, Microsoft 쪽이 "영향이 다른 보안 권한(보호 프로세스)까지 미친다"고 더 무겁게 본 결과다.

세 번째 방어선은 CVE가 없다. **PPL(Protected Process Light)** 이다. Microsoft는 PPL 우회를 자사 보안 서비스 기준(MSRC Security Servicing Criteria)의 범위 밖으로 두고 있고, 10월 수정은 UMCI 정책 검사만 고쳤다. Forshaw는 "보호 프로세스에 대한 로딩 경로는 바뀌지 않았으므로 그 경로는 여전히 동작할 것"이라고 적었다. 지금 이 시점에 이 글에서 가장 실무적인 문장이 그것이다. 두 개의 CVE는 패치가 나왔고, 세 번째는 나오지 않았다.

CISA KEV에는 세 건 모두 없다. 필자가 2026-11-25 13시(KST)에 카탈로그를 다시 받아 확인한 값은 `catalogVersion 2026.11.24`, 1,795건이고, `dateAdded`가 11-25인 항목은 0건이다. NVD의 CISA SSVC 레코드도 `exploitation: none`이다(CVE-2026-87268은 2026-09-21, CVE-2026-108398은 2026-10-13 기준). 즉 이 글을 쓰는 시점까지 실제 공격에 쓰였다는 공개 근거는 없다. PoC는 Project Zero 이슈 트래커에 첨부돼 있다.

시간순으로 접으면 이렇게 된다.

| 시점 | 사건 |
| :--- | :--- |
| 2026-08-20 | VirtualBox 소스에 "이 오류를 ERROR_BAD_EXE_FORMAT으로 번역하면 .NET이 안전하지 않은 폴백을 탄다"는 경고 주석이 추가됨(훗날 커밋에 포함) |
| 2026-09-07 | VirtualBox 수정 커밋 `167339cf` — 반환 상태 코드 변경 |
| 2026-09-11 | VirtualBox 두 번째 커밋 `d305b076` — COM의 HKCU 클래스 등록 조회 차단 |
| 2026-09-15 | Oracle 9월 CPU, VirtualBox 7.2.18, CVE-2026-87268 공개 |
| 2026-09 중순 | Forshaw, 44Con에서 Windows 코드 무결성 우회 발표 |
| 2026-09 하순 | .NET 개발자들의 요청으로 MSRC에 신고(이미 공개된 상태라 zero-day로 처리) |
| 2026-10-13 | .NET Framework 누적 업데이트, CVE-2026-108398 수정 |
| 2026-11-23 | Project Zero 원문 공개 |
| 2026-11-24 | The Hacker News 보도 |

## 2. 로더에는 두 갈래 길이 있고, 검사는 한 갈래에만 붙어 있다

### 2.1 PEImageLayout::Map

.NET Framework 4의 런타임(`CLR.DLL`)이 어셈블리 파일을 메모리로 가져오는 중심 함수는 `PEImageLayout::Map`이다. 원문이 인용한 형태는 이렇다.

```
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

이름 그대로 두 개의 레이아웃이 있다. `MappedImageLayout`은 파일을 **이미지 섹션**으로 매핑하고, `FlatImageLayout`은 **데이터 섹션**으로 매핑한다. 앞의 생성자는 이렇게 생겼다.

```
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

두 가지가 한 함수 안에 겹쳐 있다. 하나는 `SEC_IMAGE` 플래그다. 이 플래그가 붙은 `CreateFileMapping`은 커널이 파일을 PE 이미지로 해석해 이미지 섹션 객체를 만들고, 이때 이미지 서명·위치를 검사하는 상위 훅(예: VirtualBox의 DLL 로더 훅, 코드 무결성)이 개입할 지점이 생긴다. 다른 하나는 **실패 처리**다. `CreateFileMapping`이 실패했을 때 마지막 오류가 `ERROR_BAD_EXE_FORMAT`이 아니면 예외를 던져 로딩을 끝내지만, 정확히 그 오류라면 아무것도 하지 않고 빠져나온다. `image->Image`가 비어 있으므로 호출자는 폴백으로 넘어간다.

폴백은 훨씬 단순하다.

```
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

`SEC_IMAGE`가 없다. 실행 가능 페이지도 없다. 그런데 .NET에는 실행 가능 페이지가 필요 없다. IL은 JIT으로 컴파일되어 별도로 실행 가능 메모리에 놓이고, 이 데이터 섹션은 어셈블리의 메타데이터와 IL을 읽는 원본으로만 쓰인다. 즉 **이미지로 매핑되지 않은 파일도 정상적으로 실행된다**. 마지막 검사인 `PEDecoder::CheckFormat`은 PE 구조가 유효한지만 보고, 헤더의 어떤 비트가 지워졌는지는 문제 삼지 않는다.

여기서 깨지는 불변식은 메모리 안전성이 아니다. "실행되는 코드는 반드시 이미지 섹션으로 매핑된 상태를 거친다"는, 보안 코드가 당연하게 가정한 **로딩 경로의 유일성**이다. VirtualBox의 하드닝이든 Windows의 코드 무결성이든, 검사는 "이미지/실행 매핑 요청이 들어왔는가"라는 질문에 붙어 있다. 폴백 경로는 그 질문에 걸리지 않으므로, 파일이 유효한 어셈블리이기만 하면 검사 없이 실행된다.

### 2.2 WLDP 검사가 UMCI를 통과시킨 이유

`MappedImageLayout` 생성자 안의 WLDP 검사는 원래 이런 의미였다. 코드 무결성이 강제되고 있거나(`EEConfig::EnforceCodeIntegrity()`), `WldpGetLockdownPolicy`가 돌려준 정책이 "꺼짐"이 아니면서 "CONFIG_CI"가 아니면 로딩을 중단한다. 문제는 두 번째 조건의 비교 방식이다.

`WLDP_LOCKDOWN_CONFIG_CI`는 단일 비트가 아니라 플래그 집합이다. 원문에 따르면 이 상수는 `DEFINED | CONFIG_CI | UMCIENFORCE` 조합을 뜻한다. 그리고 Windows 11 S Mode에서 `WldpGetLockdownPolicy`가 돌려주는 값이 정확히 그 조합이다. 검사는 "정책이 이 알려진 조합과 같은가"를 물었고, S Mode는 그 조합을 그대로 반환했으므로 `!WLDP_LOCKDOWN_IS_CONFIG_CI(policy)`가 거짓이 되어 검사를 통과했다. UMCI가 켜져 있는데도 로딩이 계속된 것이다. 검사식이 의도한 질문은 "UMCI가 강제되고 있는가"였지만, 실제로 물은 것은 "정책 값이 특정 프리셋과 정확히 일치하는가"였다.

Microsoft의 수정은 그 질문을 바로잡는 한 줄이다.

```
  if (EEConfig::EnforceCodeIntegrity()
   || (SUCCEEDED(WldpGetLockdownPolicy(nullptr, &policy, nullptr))
   && !WLDP_LOCKDOWN_IS_OFF(policy) && WLDP_LOCKDOWN_IS_ENFORCE(policy))
  ) {
     ThrowWin32(ERROR_BAD_EXE_FORMAT);
  }
```

`WLDP_LOCKDOWN_IS_ENFORCE`는 UMCI 강제 여부를 직접 본다. 이 수정은 UMCI 경로를 닫지만, 보호 프로세스 경로는 건드리지 않는다. 4.3절에서 다시 나온다.

### 2.3 VirtualBox 훅이 폴백을 만들어 준 방식

VirtualBox는 Windows 호스트에서 VM 프로세스를 사용자로부터 보호하기 위해 DLL 로더에 훅을 건다. 그중 하나가 `NtCreateSection` 시스템 콜에 붙은 `supR3HardenedMonitor_NtCreateSection`이고, 원문이 인용한 시작부는 이렇다.

```
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

검사는 `fImage`, `fExecMap`, `fExecProt` 중 하나라도 참일 때만 돈다. `FlatImageLayout`의 `CreateFileMapping(file, nullptr, PAGE_READONLY)`는 셋 다 아니다. 이미지도 아니고, 실행 매핑도 아니고, 실행 보호도 아니다. 그래서 폴백 로드는 훅을 스치지도 않는다.

그런데 폴백이 일어나려면 `CreateFileMapping`이 `ERROR_BAD_EXE_FORMAT`으로 실패해야 한다. 그 오류는 `NtCreateSection`이 `STATUS_INVALID_IMAGE_FORMAT`을 반환할 때 설정된다. VirtualBox 훅에서 이 상태 코드가 나오는 경로는 하나다.

```
static NTSTATUS supR3HardenedScreenImageCalcStatus(int rc) {
    if (rc == VERR_LDR_ARCH_MISMATCH)
        return STATUS_INVALID_IMAGE_FORMAT;

    return STATUS_TRUST_FAILURE;
}
```

`VERR_LDR_ARCH_MISMATCH`는 VirtualBox의 PE 파서(`rtldrPEOpen`, `RTLdrOpenWithReader` 경유)가 내는 오류다. PE 파일의 아키텍처가 호스트 아키텍처와 다르면서 그 파일에 **실행 코드 섹션**이 있으면 이 오류가 난다. 여기서 AnyCPU가 결정적인 역할을 한다. C#으로 컴파일한 관리 코드 전용 어셈블리를 `AnyCPU`로 빌드하면 32비트 x86 PE가 되고, IL만 있어도 옵셔널 헤더의 `size of code`는 0이 아니다. 원문이 붙인 `dumpbin /headers` 출력이 그걸 보여 준다.

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

`characteristics 2022`는 `IMAGE_FILE_EXECUTABLE_IMAGE(0x0002)` + `IMAGE_FILE_LARGE_ADDRESS_AWARE(0x0020)` + `IMAGE_FILE_DLL(0x2000)`이다. 64비트 호스트에서 이 32비트 PE는 이미지로 매핑하려 하면 아키텍처 불일치가 되고, 코드 섹션이 있으므로 `VERR_LDR_ARCH_MISMATCH`가 난다. 결과는 `STATUS_INVALID_IMAGE_FORMAT` → `ERROR_BAD_EXE_FORMAT` → 폴백. **어셈블리를 한 바이트도 손대지 않고** VirtualBox의 이미지 검사를 지나간다.

마지막 조각은 그 어셈블리를 어떻게 하드닝된 프로세스에 로드시키느냐다. `LoadLibrary`로는 부족하고, .NET 런타임이 어셈블리로 읽어야 한다. 원문은 COM 하이재킹을 쓴다. 하드닝된 VirtualBox 프로세스가 기동 시 로드하는 COM 클래스의 등록을 현재 사용자 하이브(HKCU)에 써 두고, VM을 시작하면 그 프로세스가 COM 객체를 만들면서 .NET 런타임을 올리고, 런타임이 공격자의 어셈블리를 `FlatImageLayout`으로 읽는다.

## 3. 익스플로잇 체인

### 3.1 Windows: 비트 하나와 regasm

VirtualBox 훅이 없는 일반 Windows에서는 `NtCreateSection` 자체를 실패시켜야 한다. 원문이 찾은 조건은 COFF 파일 헤더 `Characteristics`의 `IMAGE_FILE_EXECUTABLE_IMAGE`(0x0002) 비트를 지우는 것이다. 그러면 `NtCreateSection`은 그 파일을 이미지 섹션으로 받아들이지 않지만, .NET은 그 비트를 로딩 판단에 쓰지 않으므로 어셈블리로는 그대로 유효하다. 체크섬을 고칠 필요도 없다. 원문 표현대로 "육각 편집기로 충분한" 변경이다.

로딩을 트리거하는 데는 관리 코드 어셈블리를 인자로 받는 내장 .NET 도구를 쓴다. 예를 들어 어셈블리에 `[ComUnregisterFunction]`을 달아 두고, 수정된 DLL 경로를 `regasm.exe`에 `/unregister`로 넘긴다.

```
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\regasm.exe c:\path\to\assembly.dll /unregister
```

`/unregister`는 관리자 권한을 요구하지 않고, 등록 해제 과정에서 개발자가 정의한 `UnregisterFunction`이 호출된다. 원문은 이 명령이 **UMCI가 켜진 Windows 11 S Mode에서 그대로 코드를 실행했다**고 적었다. "이론상 실패했어야 하는데 실패하지 않았다"는 문장이 2.2절의 WLDP 비교 오류를 가리킨다.

전제 조건은 분명하다. 공격자는 그 호스트에서 코드를 실행할 수 있어야 하고(저권한 사용자), 어셈블리를 로드해 줄 프로그램이 있어야 한다. `regasm.exe`는 그 역할을 하는 서명된 Microsoft 바이너리이고, 사용자 경로의 DLL을 인자로 받는다. 이 조합이 "앱 컨트롤이 허용한 도구로 허용되지 않은 코드를 실행하는" 형태를 만든다.

### 3.2 PPL: 관리자 없이 TCB 등급으로

PPL은 일반 프로그램이, 관리자 권한이 있어도 들어갈 수 없게 만든 프로세스다. Forshaw는 `WerSecureFault.exe`가 런타임에 로드하는 COM 객체를 하이재킹해, 수정된 .NET DLL을 그 프로세스 안에서 실행했다. 원문은 이를 "관리자 권한 없이 TCB 등급의 PPL로 임의 코드"라고 적는다.

여기에 두 가지 세부가 붙는다. 첫째, 원래의 PP(Protected Process)는 DLL의 Authenticode 서명에 **페이지 해시**를 요구하는데 .NET 런타임 DLL에는 그것이 없어서 이 기법이 통하지 않는다. PPL만 대상이다. 둘째, 기본 설치에서 PPL 경로에는 WLDP 검사가 아예 개입하지 않는다. 원문의 표현으로 ".NET은 보호 상태를 확인해야 하지만, 하지 않는다." 10월 수정이 `WLDP_LOCKDOWN_IS_ENFORCE`로 바꾼 것은 UMCI 로딩 경로이고, 보호 프로세스 로딩 경로는 그대로다. 그래서 이 경로에는 CVE도, 패치도 없다.

### 3.3 공격자가 얻는 것과 얻지 못하는 것

얻는 것은 "이미 실행 권한이 있는 로컬 사용자가, 그 호스트에 걸린 코드 허용 정책을 우회해, 서명되지 않은 코드를 더 높은 신뢰 등급에서 실행하는 것"이다. S Mode 기기나 WDAC이 적용된 관리 단말에서 허용 목록 밖 코드를 돌리는 것, VirtualBox가 설치된 호스트에서 VM 프로세스 안에 코드를 심는 것, PPL 등급에서 지속성을 잡는 것이 해당한다.

얻지 못하는 것은 원격 실행, 게스트→호스트 탈출, 관리자 권한 자체다. PPL 안에서 코드가 돌아도 그 프로세스의 권한을 그대로 쓰는 것이지, 관리자 토큰을 얻는 것은 아니다. 원문이 명시한 대로 .NET Framework 4에 한정되고(v3.5·v2는 이후 `LoadLibrary` 단계에서 실패), .NET 5 이상은 조사되지 않았다.

### 3.4 흔적은 "없는 로그"에 있다

이 공격의 탐지는 이벤트가 찍히는 것을 보는 방식으로는 잘 되지 않는다. 이미지 검사가 아예 돌지 않았기 때문에 코드 무결성 차단 이벤트(예: 3033/3077 계열)가 남지 않는다. 대신 봐야 할 것은 로딩의 **모양**이다. 아래는 필자가 원문의 메커니즘에서 도출한 휴리스틱이며, 벤더가 공개한 IOC가 아니다.

- `regasm.exe`·`regsvcs.exe`가 사용자 쓰기 가능 경로의 DLL을 `/unregister`로 로드하는 실행. 특히 `C:\Users\*\AppData`, `%TEMP%`, 다운로드 폴더.
- `VirtualBoxVM.exe`(및 이를 띄우는 `VirtualBox.exe`)가 `clr.dll`을 로드한 뒤 서명되지 않은 관리 DLL을 읽는 흐름. 정상 VirtualBox 사용에서도 COM을 쓰므로, **HKCU에 등록된 CLSID**와 결합해 볼 때 의미가 생긴다.
- `HKCU\Software\Classes\CLSID\{...}\InprocServer32`가 `mscoree.dll`을 가리키거나 `Assembly`·`RuntimeVersion` 값을 통해 관리 DLL을 지정하는 등록. VirtualBox나 `WerSecureFault.exe`가 로드하는 클래스라면 우선순위가 높다.
- 파일 자체의 흔적: COFF `Characteristics`에서 `0x0002`가 빠진 관리 PE. 아래 YARA 규칙은 그 조건만 본다. 32비트(PE32) 관리 어셈블리로 한정했고, 오브젝트 파일이나 리소스 전용 DLL도 걸릴 수 있으므로 **탐지가 아니라 분류(triage)** 용도다.

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

정상적인 .NET DLL은 `characteristics`가 `0x2022`다. 그 값에서 `0x0002`만 빠진 파일이 관리 메타데이터를 갖고 있다면, 누군가 로더 폴백을 노리고 한 비트를 지웠을 가능성을 먼저 의심할 수 있다. 다만 원문의 VirtualBox 경로는 **파일을 전혀 수정하지 않는다**. 이 규칙은 Windows 코드 무결성 경로만 잡는다는 점을 분명히 해 둔다.

## 4. 패치 분석

### 4.1 VirtualBox: 상태 코드 하나와 COM 조회 차단

첫 번째 커밋은 2.3절의 함수를 이렇게 바꾼다.

```diff
+       Update 2026-08-20: We should not return anything that can be translated
+       to ERROR_BAD_EXE_FORMAT here, because .NET may take an unsafe fallback
+       path (FlatImageLayout) which maps the file as data and interprets the
+       content without strict certificate checking.
     if (rc == VERR_LDR_ARCH_MISMATCH)
-        return STATUS_INVALID_IMAGE_FORMAT;
+        return STATUS_FILE_NOT_SUPPORTED; /* not STATUS_INVALID_IMAGE_FORMAT!  */
```

주석의 날짜가 8월 20일인 것이 눈에 띈다. 수정 커밋은 9월 7일이고, 그 사이에 "왜 이 상태 코드를 쓰면 안 되는지"를 소스에 남겨 둔 셈이다. 주석은 후속 조치까지 적어 두었다. 다른 이미지(리소스 등)에서 문제가 되면 IPRT에서 COM descriptor(CLI 헤더, `BSJB` 매직)를 보고 별도 오류 코드를 주자는 내용이다.

두 번째 커밋 `d305b076`은 COM의 현재 사용자 하이브 등록 조회를 막는다.

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

`COMGLB_RESERVED4`는 문서화되지 않은 전역 옵션이고, 이 비트를 세우면 HKCU 클래스 등록을 조회하지 않는다. 즉 2.3절의 "현재 사용자 하이브에 COM 등록을 심는" 진입 자체를 좁힌다. 상태 코드 수정이 폴백을 막고, 이 수정이 진입을 막는 구조다.

빌드 기준으로 정리하면 이렇다. Oracle 9월 CPU의 리스크 매트릭스는 CVE-2026-87268의 영향 버전을 **7.2.16**으로 명시하고, Windows 호스트에만 적용된다고 적는다. VirtualBox 체인지로그 기준 7.2.18이 2026-09-15에 나왔고, 현재 최신은 2026-10-20에 나온 **7.2.22**다. 7.2.18 이상이면 이 수정을 포함한다. The Hacker News의 표는 영향 버전에 7.2.16과 7.2.18을 함께 적어 두었는데, 벤더 어드바이저리와 체인지로그를 대조하면 7.2.16이 영향, 7.2.18이 수정 빌드다. 배포된 바이너리 기준으로는 `VirtualBoxVM.exe`의 파일 버전을 직접 확인하는 편이 안전하다.

### 4.2 .NET Framework: OS별 KB

Microsoft의 수정은 2.2절의 `WLDP_LOCKDOWN_IS_ENFORCE` 한 줄이다. 2026-10-13 누적 업데이트에 포함됐고, MSRC 레코드는 `Important`, 8.8, `exploited: No`, `publicly disclosed: Yes`, `Exploitation Less Likely`, CWE-426(`Untrusted Search Path`)이다. FAQ는 영향 범위를 이렇게 적는다. "인증된 공격자가 특수 제작한 .NET 어셈블리를 대상 시스템에 배치하고 보호 프로세스가 로드하도록 등록할 수 있다. 성공하면 WDAC 제한을 우회해 보호 프로세스 안에서 코드를 실행할 수 있다. 사용자 상호작용은 필요 없다."

.NET Framework 누적 업데이트는 통합 패키지가 아니라 OS·프레임워크 버전별로 나뉜다. 2026-10-13 릴리스 노트의 표를 옮기면 다음과 같다.

| Windows 버전 | .NET Framework | KB |
| :--- | :--- | :--- |
| Windows 11 26H2 | 3.5, 4.8.1 | **5127694** |
| Windows 11 26H1 | 4.8.1 | 5127691 |
| Windows 11 25H2 / 24H2 | 3.5, 4.8.1 | 5127690 |
| Windows 11 23H2 | 3.5, 4.8.1 | 5127692 |
| Windows Server 2025 | 3.5, 4.8.1 | 5127690 |
| Windows Server 2022 | 3.5, 4.8 / 4.8.1 | 5127687 / 5127693 |
| Windows 10 22H2 · 21H2 | 3.5, 4.8 / 4.8.1 | 5127683 / 5127689 |
| Windows 10 1809 · Server 2019 | 3.5, 4.7.2 / 4.8 | 5127666 / 5127685 |
| Windows 10 1607 · Server 2016 | 4.6.2~4.7.2 / 4.8 | 5126868(LCU 포함) / 5127684 |

26H2 기준 KB5127694의 제목은 "October 13, 2026-KB5127694 Cumulative Update for .NET Framework 3.5 and 4.8.1 for Windows 11 26H2"이고, 같은 날 나온 다른 .NET 보안 수정 18건과 함께 배포된다. 즉 이 취약점 하나 때문에 별도 패키지가 나온 것이 아니라, 10월 정기 업데이트를 적용했는지가 기준이다. `Get-HotFix -Id KB5127694` 같은 확인은 OS에 따라 KB 번호가 달라지므로, 자산 관리 도구에서는 **릴리스 노트의 표를 OS별로 매핑**해 두는 편이 낫다.

### 4.3 남은 것: PPL과 정책 설계

수정 두 개로 닫히지 않은 것이 있다.

첫째, PPL 경로다. 10월 수정은 UMCI 검사만 고쳤고, 원문은 그 경로가 여전히 동작한다고 본다. Microsoft가 PPL 우회를 서비스 범위 밖으로 두는 이상, CVE와 패치를 기대하기 어렵다. 방어자 입장에서 이 경로를 줄이는 방법은 로딩 자체를 막는 것이 아니라 **진입점을 줄이는 것**이다. `WerSecureFault.exe` 같은 보호 프로세스가 로드하는 COM 클래스의 HKCU 등록을 모니터링하고, 사용자 하이브 COM 등록을 정책으로 제한하는 것이 현실적인 통제다.

둘째, WDAC 정책의 의미다. 이 취약점은 "WDAC을 켰다"만으로는 막히지 않는다. 원문에 따르면 `UMCI` 또는 `Dynamic Code Security` 옵션이 켜져 있어야 하고, `Dynamic Code Security`는 기본값이 아니며 `Assembly::Load(byte[])`까지 막기 때문에 일부 애플리케이션이 깨질 수 있다. Microsoft 문서는 이 옵션이 **Windows 11 24H2·Windows Server 2025 이상에서만 감사 모드**를 지원하고, 그 이전 버전에서는 정책이 감사 모드여도 강제된다고 적는다. 3114 이벤트로 차단 기록이 남는다는 점도 함께 봐야 한다. WDAC를 운영하는 조직이라면 "UMCI를 켠 정책인가"와 "Dynamic Code Security를 켤 수 있는가"를 이 취약점 기준으로 다시 확인할 필요가 있다.

셋째, .NET Framework 4를 쓰는 애플리케이션의 로딩 경로다. `Assembly.Load(byte[])`나 `Assembly.LoadFrom`으로 외부 경로의 어셈블리를 읽는 코드가 있다면, 그 자체가 이 취약점의 "프로그램"이 될 수 있다. 10월 패치 이후에는 WLDP 검사가 UMCI를 제대로 보므로 S Mode나 UMCI 환경에서는 막히지만, UMCI가 없는 환경에서는 여전히 폴백이 가능하다. 애플리케이션 개발자 입장에서 방어적인 선택은 로드 전에 파일의 출처와 서명을 직접 확인하는 것이다.

## 5. 정리 대신 남기는 것

이 취약점에는 메모리 손상이 없다. 힙 오버플로도, 경쟁 조건도, 정수 오버플로도 없다. 잘못된 것은 두 가지다. `CreateFileMapping` 실패 시 `ERROR_BAD_EXE_FORMAT`을 특별 취급한 분기, 그리고 WLDP 플래그를 "정확히 같은 조합인가"로 비교한 조건식. 그 두 줄이 만든 경로 위에 VirtualBox의 하드닝과 Windows의 코드 무결성, PPL 보호가 나란히 서 있었고, 그중 어느 것도 "데이터 섹션으로 매핑된 어셈블리가 실행될 수 있다"는 사실을 검사하지 않았다.

방어 설계의 관점에서 이 사건이 남기는 질문은 하나다. 우리가 건 검사는 **요청의 플래그**를 보는가, **결과로 실행되는 것**을 보는가. `SEC_IMAGE`가 붙은 요청만 감시하는 훅은, 같은 파일이 다른 경로로 실행되는 순간 아무것도 보지 못한다. VirtualBox는 그 질문에 상태 코드 변경으로 답했고, Microsoft는 정책 검사 문구를 고쳐 답했다. PPL은 아직 답하지 않았다.

---

**1차 자료**: Project Zero, James Forshaw, "VirtualBox Process Hardening on Windows 2026 Edition: What's a Single Bit Between Friends?" (2026-11-23) · VirtualBox 커밋 `167339cf659283e7bf465c3c7da32e8a547a528a`(2026-09-07)와 `d305b076f67d079378c8439e530a8d95b07180e4`(2026-09-11) · Oracle Critical Security Patch Update September 2026, CVE-2026-87268 · VirtualBox Changelog 7.2(7.2.18 2026-09-15, 7.2.22 2026-10-20) · Microsoft MSRC CVE-2026-108398(2026-10-13, Important 8.8) · .NET Framework 2026년 10월 누적 업데이트 릴리스 노트 · KB5127694 · NVD CVE-2026-87268(`Analyzed`, 2026-09-15)·CVE-2026-108398(`Awaiting Analysis`, 2026-10-13) · CISA KEV 카탈로그 2026.11.24(1,795건, 두 CVE 미등재, 2026-11-25 13시 KST 확인) · CISA SSVC 레코드(양쪽 `exploitation: none`) · The Hacker News, "Google Researcher Shows How a Single Bit Change in .NET Files Bypassed Windows Code Integrity"(2026-11-24) · Microsoft Learn, App Control for Business and .NET(Dynamic Code Security, 3114 이벤트).

원문은 PoC를 Project Zero 이슈 트래커에 첨부했고, 이 글은 재현하지 않았다. 3.4절의 탐지 휴리스틱과 YARA 규칙은 원문 메커니즘에서 필자가 도출한 것으로, 벤더가 배포한 IOC가 아니다. CVE-2026-87268의 영향 버전과 수정 빌드는 Oracle 어드바이저리·체인지로그 기준이며, The Hacker News 표기와 다르다.
