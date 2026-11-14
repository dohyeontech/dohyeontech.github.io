---
title: "[긴급 분석] ScreenConnect RMM+ 빈 액세스 키 인증 우회 — 48개 조직을 넘긴 SCKit 공급망 캠페인"
slug: screenconnect-rmm-accesskey-bypass-sckit
date: "2026-11-14"
category: "공급망 공격"
tags: ["공급망공격", "RMM", "SCKit", "ScreenConnect", "Huntress"]
thumbnail: /assets/images/thumb_sckit_rmm.png
summary: "서드파티 확장 RMM+의 빈 액세스 키가 계정·MFA를 우회해 POST 한 번을 인증으로 통과시켰다. 90분 만에 48개 조직 288개 엔드포인트를 감염시킨 SCKit 체인의 원리(RelayTrap 세션 탈취)와 침해 지표, 온프레미스 파트너가 지금 해야 할 격리·폐기 절차를 정리했다."
author: "김도현"
original: "https://dohyeontech.wordpress.com/2026/11/14/%ea%b8%b4%ea%b8%89-%eb%b6%84%ec%84%9d-screenconnect-rmm-%eb%b9%88-%ec%95%a1%ec%84%b8%ec%8a%a4-%ed%82%a4-%ec%9d%b8%ec%a6%9d-%ec%9a%b0%ed%9a%8c-48%ea%b0%9c-%ec%a1%b0%ec%a7%81%ec%9d%84/"
---
원격 관리·모니터링(RMM) 콘솔은 MSP 비즈니스의 신뢰 뿌리다. 고객사 엔드포인트에 상시 연결되어 있고, 그 콘솔에 접근하는 순간 고객사 전체가 같은 권한으로 열린다. 2026년 11월 11일, 그 뿌리 자체가 침해 경로가 된 캠페인이 관측됐다. Huntress는 11월 11일 17:47 UTC부터 약 90분 동안 최소 288개 관리 엔드포인트, 48개 조직에서 악성 ScreenConnect 클라이언트 설치를 확인했다. 감염의 3분의 1은 첫 10분 안에 몰렸고, 최신 빌드인 26.6.6.9747과 26.7.6.9783 모두 영향을 받았다.

진입점은 ScreenConnect 본체가 아니라 그 위에 얹힌 서드파티 확장이었다. ConnectWise는 11월 11일 22:45 UTC, Labtech Plus·RMM Plus·RMM+·RMM Plus Password Link·RMM+ Password Link 등 확장 5종을 약 400개 파트너 환경에서 비활성화했다고 공지했다. Huntress는 그중 **RMM+ 1.0.31과 1.0.32**가 실제 공격 경로였다고 특정했다. 공격자는 그 확장이 제공하는 API를 인증 없이 호출해 관리 패널 명령을 실행했고, 48개 조직의 엔드포인트에 공격자 소유의 ScreenConnect 클라이언트를 심었다.

캠페인은 11월 11일로 끝나지 않았다. 11월 13일 14:23 ET, Blackpoint SOC는 **온프레미스 ScreenConnect 인스턴스**를 대상으로 한 2차 웨이브를 관측했다. `C:\WINDOWS\TEMP\sckit-decoder.ps1`이 다시 나타났고 `185.241.211[.]197`으로 향하는 무단 클라이언트 설치가 확인됐다. 샘플은 아직 확보되지 않았지만 이전 툴킷의 변형으로 추정된다. 호스팅 환경은 확장이 일괄 비활성화됐지만, 온프레미스 파트너는 아직 자기 인스턴스의 상태를 자기가 확인해야 하는 국면이다. 이 확장 결함에는 아직 CVE가 부여되지 않았다.

## 1. 구조적 결함: 계정도 MFA도 아닌 공유 키 한 줄

RMM+는 ScreenConnect의 계정·역할·MFA 체계를 그대로 쓰지 않는다. 대신 확장 자체가 발급하는 **공유 액세스 키(shared access key)** 하나로 요청을 인증한다. 관리자는 확장 설정에서 이 키를 넣고, 외부 자동화는 그 키를 헤더나 파라미터에 실어 확장 API를 호출한다. 문제는 키를 *넣지 않은* 설치의 기본값이었다.

> 확장 설명문은 “강한 키를 설정하라”고 안내하지만, 키를 설정하지 않은 상태의 기본값은 빈 문자열(`""`)이었다. 인증 검사는 요청에서 온 값과 설정값을 비교하는데, 설정값이 빈 문자열이면 **요청도 빈 문자열일 때 비교가 성립**한다. 빈 값을 거부하는 별도 검사가 없었기 때문에, 키를 한 번도 넣지 않은 설치는 그 자체로 무인증 API가 됐다.

이 결함의 성격을 정확히 이해하려면 두 가지를 구분해야 한다. 첫째, 이건 암호학적 취약점이 아니라 **설정 기본값과 입력 검증의 문제**다. 메모리 손상도, 경쟁 조건도 없다. 요청 한 번이 형식상 올바르게 도착하면 인증 단계가 통과한다. 둘째, 이 확장은 ScreenConnect의 계정 체계를 우회하도록 설계됐기 때문에, 확장이 뚫리면 **MFA를 켜 둔 파트너도 보호받지 못한다**. 관리 콘솔의 2차 인증은 이 경로와 무관하다.

```
// 결함 구조를 재구성한 의사 코드 (벤더 소스 아님)
// 확장 설정: accessKey 미설정 → 기본값 ""
$configured = get_extension_setting('accessKey');   // "" (관리자가 입력한 적 없음)

$incoming = $_POST['key'];                          // 공격자: ""
if ($incoming === $configured) {                    // "" === "" → true
    dispatch_command();                             // 인증 통과, 명령 실행
}
```

실무적으로 이 구조가 위험한 이유는 **실패가 조용하다**는 점이다. 확장을 설치하고 키를 넣지 않은 채로 몇 달을 운영해도 화면에는 아무 경고가 없다. 관리자는 확장이 “동작한다”고 생각하지만, 실제로는 인증 계층이 비어 있는 상태로 열려 있을 수 있다. 사후에 확인할 수 있는 것은 설정 화면의 키 필드가 비어 있었는지 여부뿐이다.

## 2. 익스플로잇 체인: Run 명령에서 세션 쿠키 함정까지

인증을 통과한 뒤의 흐름은 정교하다. 공격자는 감염된 패널의 **Run 명령**으로 대상 엔드포인트에 SYSTEM 권한 일괄 실행을 걸었다. Huntress가 정적 분석으로 복원한 단계는 다음과 같다.

먼저 `C:\Windows\TEMP\sc.msi`가 무인 설치된다. 공격자가 제어하는 ScreenConnect 설치본으로, 정상 클라이언트와 나란히 두 번째 연결을 만든다. 이어서 base64 드로퍼 `sckit-run.bat`과 `sckit-decoder.ps1`이 시스템별로 맞춤화된 툴킷을 풀어놓는다.

툴킷 구성은 목적이 분명하다. `Panel-Lateral.ps1`은 패널 장악을 시도하는데, Huntress가 관측한 모든 로그에서 이 단계는 실패했다. `sckit-loader.ps1`과 `k<32hex>.ps1`은 `C:\ProgramData\RelayTrap`에 트랩을 전개한다. `install.ps1`과 `CWInstall_<8hex>-c1\Installer.ps1`은 Defender 예외를 추가하고 두 번째 공격자 클라이언트를 설치한다. `TrapWatch.ps1`은 `RelayTrap.cs`를 컴파일해 호스트별 `trapbins\<...>\RelayTrap.exe`를 만들고, `TrapWatch` 예약 작업으로 재부팅 이후에도 살아남게 한다. 정상 ScreenConnect 서비스는 중지·수동 시작으로 바꾸고, 그 자리는 공격자 사본이 대체한다. 사용자가 서비스를 재시작해도 원래 것이 돌아오지 않는다.

이 체인의 핵심은 **RelayTrap**이다. 이름 그대로 세션 쿠키를 중계하는 함정이다. 기술자 워크스테이션의 `.aspxauth` 쿠키를 훔쳐 패널로 되돌려 보내고, 그 기술자가 접근할 수 있는 다른 세션까지 열거하는 것이 코드상 의도다. 다만 Huntress와 Blackpoint 모두 **실제 기술자 워크스테이션으로의 전이 성공은 아직 관측하지 못했다**. 이 캠페인의 목표가 엔드포인트 장악을 넘어 관리자 세션 탈취로 넘어가는 지점이 바로 여기라서, 이 부분의 관측 여부는 앞으로의 피해 범위를 가를 것이다.

```
# Huntress·Blackpoint가 공개한 침해 지표 (2026-11-14 기준)
호스트 경로
  C:\Windows\TEMP\sc.msi
  C:\Windows\TEMP\sckit-run.bat
  C:\WINDOWS\TEMP\sckit-decoder.ps1
  C:\ProgramData\RelayTrap\            (RelayTrap.cs, trapbins\...\RelayTrap.exe)
예약 작업
  TrapWatch
네트워크
  185.241.211[.]197      (2차 웨이브 클라이언트)
  ns.mo7sen[.]dev        (EadF.php 스테이징)
서비스
  ScreenConnect 서비스 시작 유형: 자동 → 수동, 바이너리 경로 교체
Defender
  추가된 예외 경로 (install.ps1 계열)
```

2차 웨이브의 성격도 짚어둘 필요가 있다. 1차가 호스팅 파트너 환경의 확장 취약점을 통한 대량 감염이었다면, 11월 13일의 재공격은 이미 침투한 온프레미스 인스턴스를 다시 두드린 것으로 보인다. Blackpoint가 확인한 경로는 이전 툴킷과 동일한 파일명 규칙을 쓰지만 샘플이 없어 코드 수준 비교는 불가능하다. 참고로 9월의 유사 웜 활동 이후 ConnectWise가 배포한 파일 전송 취약점 **CVE-2026-84869(CVSS 9.9)**도 이번 캠페인에서 재사용된 것으로 보고됐다.

## 3. 공식 대응과 그 한계: 확장을 끄는 것으로는 끝나지 않는다

ConnectWise의 조치는 호스팅 환경에 대해서는 명확하다. 문제 확장 5종을 약 400개 파트너 환경에서 비활성화했고, 호스팅 고객은 별도 조치 없이 그 상태가 적용된다. 그러나 온프레미스 파트너에게 이 조치는 자동으로 적용되지 않는다. 그리고 확장을 끄는 행위 자체가 침해를 되돌리지는 않는다.

공식 지침에서 가장 중요한 문장은 **“확장 비활성화만으로는 이미 심긴 접근이 제거되지 않는다”**는 것이다. 확장은 진입점이었을 뿐이고, 침투 이후 단계는 호스트에 파일과 서비스, 예약 작업으로 남는다. 그래서 순서가 중요하다. 침해가 의심되는 인스턴스는 먼저 네트워크에서 격리하고, 그 다음에 세션과 자격증명을 폐기한다. ScreenConnect 세션 토큰, 확장 API 키, 패널 관리자 계정의 비밀번호와 MFA 등록 정보까지 포함된다. 재설치나 확장 비활성화를 먼저 하면 증거가 사라지고, 남아 있던 접근 경로가 그대로 살아남는다.

또 하나 실무에서 자주 어기는 지침이 있다. **감염된 호스트를 ScreenConnect로 원격 진단하지 말 것**. 감염 호스트에는 공격자 클라이언트가 함께 설치되어 있기 때문에, 원격 세션을 열면 진단 과정 자체가 전파 경로가 된다. 포렌식은 EDR 콘솔이나 오프라인 수집으로 해야 한다.

```
# 온프레미스 파트너 점검 순서 (권고)
1. 확장 설정에서 RMM+ 계열 accessKey 가 비어 있는지 확인 → 즉시 비활성화
2. ProgramData\RelayTrap, TrapWatch 예약작업, TEMP\sckit-* 파일 존재 여부 스캔
3. ScreenConnect 서비스 바이너리 경로·시작 유형 변조 여부 확인
4. Defender 예외 목록에 낯선 경로가 추가됐는지 확인
5. 외부로 나가는 185.241.211.197 / ns.mo7sen.dev 연결 차단 및 로그 보존
6. 침해 확정 시: 호스트 격리 → 세션·API 키·계정 자격증명 폐기 → 재구축
7. 감염 호스트는 ScreenConnect 원격 세션으로 진단하지 않는다
```

이번 사건이 남기는 교훈은 취약점 하나의 수명보다 길다. RMM 확장은 관리 평면 위에서 동작하고, 그 평면은 고객사 전체와 연결된다. 확장 하나의 기본 설정이 인증 계층을 대체하는 구조라면, 그 확장은 보안 제품이 아니라 **인증 면제 구역**이 된다. MSP 입장에서 확장 목록은 이제 자산 목록이 아니라 공격 표면 목록으로 다뤄야 한다. 설치 시점의 기본값을 확인하고, 사용하지 않는 확장은 지우고, 확장이 가진 API가 무엇을 할 수 있는지 목록으로 관리하는 것 — 이 세 가지가 이번 캠페인에서 실제로 뚫린 지점을 막는 최소한의 절차다.

*참고 자료: [Huntress 기술 분석](https://www.huntress.com/blog/sckit-worm-rogue-screenconnect), [ConnectWise 파트너 지침](https://www.connectwise.com/blog/screenconnect-security-update-guidance-for-partners), [Blackpoint SITREP](https://blackpointcyber.com/blog/screenconnect-attack-sckit/), [BleepingComputer](https://www.bleepingcomputer.com/news/security/new-worm-like-sckit-malware-targets-msps-in-screenconnect-attacks/)*
