# ComfyUI-ControlPanel: Allow flagged as latest

## 작업 요청

`ComfyUI-ControlPanel` 설정에 **Allow flagged as latest** Boolean 옵션을 추가한다. 기본값은 `false`다.

옵션이 켜져 있고 기존 **Replace Manager Repository Data**가 활성화되어 있으면, ControlPanel이 제공하는 Manager 캐시의 `latest_version`을 `Active`와 `Flagged` 버전 중 가장 높은 정식 버전으로 선택한다. Registry 서버나 설치된 Manager 소스는 수정하지 않는다.

이 문서는 구현 지시서다. 대상 저장소의 현재 checkout, AGENTS.md, 기존 변경 사항을 먼저 확인하고 구현한다. 현재 다른 저장소에서 조사한 공개 main 기준이므로 함수 위치와 호출 관계는 다시 확인한다.

대상: https://github.com/craftingmod/ComfyUI-ControlPanel

## 기존 경로와 변경 위치

기존 경로를 재사용한다. 별도 캐시 서비스, 전역 HTTP 가로채기, Manager monkey patch를 만들지 않는다.

1. `frontend/src/index.ts`: ComfyUI 설정 등록, backend 설정 초기 동기화, 변경 요청.
2. `frontend/src/constants.ts` 및 기존 API 서비스: 설정 ID와 설정 저장 경로.
3. `backend/manager_settings.py`: ControlPanel 내부 설정 저장.
4. `backend/manager_routes.py`, `backend/manager_api.py`: 설정 읽기/쓰기, 상태 응답, 기존 캐시 작업 연결.
5. `backend/manager_cache.py`: Registry 조회, 캐시 생성 및 Manager 캐시 배포.

확인한 주요 함수는 `refresh_comfy_registry_nodes_cache`, `manager_compatible_registry_nodes_cache`, `deploy_registry_nodes_cache_to_manager`다. 기존 lock, job, 원자적 JSON 저장을 유지한다.

## 설정 계약

- UI 이름: `Allow flagged as latest`.
- backend 영속 키 및 응답 필드: `allow_flagged_as_latest`.
- 기본값: `false`. 기존 설정 파일에 키가 없어도 꺼진 상태로 처리한다.
- 기존 Manager repository 설정과 같은 영역에 배치하고 기존 Boolean 설정 패턴을 따른다.
- 툴팁은 동작과 적용 시점을 설명한다. 예: `Include flagged releases when choosing the latest version in ControlPanel's Manager cache. Requires Replace Manager Repository Data. Update the Manager cache and restart ComfyUI to apply. Installation permission is configured separately in Manager.`
- frontend는 backend에서 저장한 값을 초기 동기화한다. 초기 동기화가 불필요한 저장/캐시 작업을 반복하지 않도록 기존 동기화 패턴을 확인한다.
- 저장 API는 Boolean을 엄격히 검증하고, 기존 control route 접근 제한을 그대로 적용한다. 실패는 기존 오류 UI에 표시한다.
- Replace Manager Repository Data가 꺼져 있으면 설정값은 보존하되 Manager 캐시와 설정에 영향을 주지 않는다.
- 옵션 변경만으로 다운로드/설치/업데이트를 실행하지 않는다. 적용은 기존 Update Manager Cache 또는 Rebuild Manager Cache와 ComfyUI 재시작 경로를 사용하고 UI에 이를 설명한다.

## 최신 버전 선택

옵션이 켜진 캐시 갱신에서 다음을 수행한다.

1. 기존 Registry 노드 목록과 호환성 조회 조건을 유지한다.
2. 해당 노드의 `/nodes/{node_id}/versions`에서 `NodeVersionStatusActive`와 `NodeVersionStatusFlagged` 버전을 조회한다. 서버 상태 필터 사용 여부와 별개로 응답에서도 허용 상태를 검증한다.
3. `Pending`, `Banned`, `Deleted`, 알 수 없는 상태, deprecated 버전은 후보에서 제외한다. 노드 자체가 금지 상태인 경우도 포함하지 않는다.
4. 정식 `X.Y.Z`만 후보로 삼고 정수 튜플로 비교한다. 문자열 정렬을 사용하지 않는다. `0.10.0 > 0.9.5`여야 한다. prerelease나 임의 형식의 버전까지 지원하는 새 파서를 만들지 않는다.
5. 기존 compatibility 요구 사항을 무시하지 않는다. 후보별 지원 조건 확인이 필요하면 기존 의존성/비교 코드와 공식 API 계약을 재사용한다. 현재 환경과 호환되는 후보만 선택한다.
6. 최상위 후보의 실제 버전 객체를 `latest_version`으로 사용한다. `version` 문자열만 교체하여 기존 버전의 ID/metadata와 섞지 않는다.
7. `Flagged` 상태를 `Active`로 위조하거나 `status_reason`을 삭제하지 않는다. 이 옵션은 로컬 최신 버전 선택 정책이다.
8. 노드별 조회 실패 또는 유효 후보 없음은 로그를 남기고 그 노드의 원본 Registry `latest_version`을 유지한다. 다른 노드 캐시 갱신까지 실패시키지 않는다.

추가 조회는 기존 HTTP session을 재사용하고 동시 요청 수를 제한한다. 전체 노드 수만큼 무제한 task를 실행하거나 모든 후보 설치 ZIP을 다운로드하지 않는다. 새 의존성은 추가하지 않는다.

## 캐시 및 적용 경계

- Registry에서 받은 원본 캐시와 Manager에 배포하는 선택 결과의 관계를 명확히 유지한다. 가능하면 원본 목록을 보존하고 기존 배포용 projection에 최신 버전 선택 결과를 적용한다.
- 옵션을 끄고 캐시 갱신하면 원본 Registry Latest로 복원되어야 한다. 이전 Flagged 선택이 원본 캐시에 섞여 계속 남으면 안 된다.
- 기존 증분 갱신은 오래된 Active 버전을 `latest_version`으로 가진 노드에서 신규 Flagged 버전을 놓칠 수 있다. 전체 결과에 필요한 버전 조회를 적용해, 노드 목록의 증분 응답에 없다는 이유로 해당 노드를 영구히 건너뛰지 않는다.
- startup 배포, Update Manager Cache, Rebuild Manager Cache 모두 같은 정책을 적용한다. 설정값 또는 정책이 달라진 캐시를 그대로 재사용하지 않도록 기존 cache metadata/invalidation을 확장한다.
- 증분 갱신 timestamp를 로컬에서 선택한 Flagged 버전 생성 시각으로 앞당겨 원본 노드 업데이트를 누락시키지 않는다.
- startup의 동기 파일 복사 중 네트워크를 새로 호출하지 않는다. 조회는 기존 비동기 갱신 경로에 둔다. 필요한 선택 캐시가 없으면 원본 Latest를 사용하고 기존 갱신 작업으로 채운다.
- Manager의 메모리 `cnr_map` 갱신 여부를 확인한다. 기존 구조가 캐시 배포 후 재시작을 요구하면 그대로 안내한다. 즉시 반영용 Manager 내부 hook을 추가하지 않는다.

## 설치 허용과 구분

Manager의 `allow_flagged_nodepack_install = true`는 설치 허용 설정이며 최신 버전 선택과 별개다.

- 이 작업에서 해당 Manager 설정을 자동으로 켜거나 보안 수준을 변경하지 않는다.
- Registry `/install?version=...`에서 실제 후보 버전을 지정하는 현재 Manager 경로를 확인한다. 로컬 `latest_version`만 바꾸고 설치가 이전 Active 버전을 받는 구현이면 미완료다.
- 버전 선택 dropdown이 Flagged를 별도로 필터링하는 동작은 이번 범위에서 Manager 소스를 수정해 해결하지 않는다. Latest/자동 업데이트 경로와 수동 버전 목록의 차이를 최종 보고한다.
- 실제 설치 제한은 기존 Manager 정책이 판단하도록 둔다. 설치 차단 오류를 성공으로 처리하거나 상태를 위조하지 않는다.
- 이 기능의 offline은 Manager의 repository data 경로를 의미한다. ControlPanel 캐시 갱신 자체는 Registry 네트워크 접근을 사용한다.

## 구현 순서

1. 현재 설정 동기화, 원본 캐시, 배포용 캐시, Manager Latest 소비 및 명시 버전 설치 흐름을 읽는다.
2. 기존 저장/API/UI 패턴으로 설정을 추가한다.
3. 기존 캐시 갱신 경로에 버전 조회와 최소 선택 함수를 추가한다.
4. 활성/비활성 전환, 증분 갱신, startup 캐시 재사용을 연결한다.
5. README에 설정의 의미, 적용 절차, 설치 허용과의 차이를 짧게 추가한다.
6. 변경 파일과 검증 결과 또는 미실행 항목을 보고한다. commit/push/release는 하지 않는다.

## 검증 계약

기존 테스트 구조에 선택과 캐시 전환을 검증하는 작은 테스트를 추가한다. 별도 프레임워크나 실제 Registry 호출을 사용하는 테스트를 만들지 않는다.

필수 사례:

- 기본값/설정 OFF는 원본 Latest 유지.
- 설정 ON: Active `0.6.1`, Flagged `0.9.4`, Pending `0.9.5`라면 `0.9.4` 선택.
- 이후 `0.9.5`가 Flagged로 바뀌면 다음 캐시 갱신에서 `0.9.5` 선택.
- 정수 버전 비교, 금지/삭제/deprecated/잘못된 버전 제외.
- 조회 실패는 원본 Latest 유지, 실제 상태/ID/metadata 보존.
- ON → OFF 후 배포 결과 복원, 증분 목록에 없는 노드도 최신 후보 재확인.
- Replace Manager Repository Data OFF에서는 Manager 상태 변경 없음.
- backend 저장값의 UI 재동기화와 잘못된 Boolean 요청 거부.

이 지시서는 검증 실행을 요청하지 않는다. 테스트/빌드/실제 설치는 실행하지 말고, 추가한 검증과 필요한 실행 명령을 보고한다. 추후 검증을 요청받으면 대상 저장소 AGENTS.md 및 docs/TESTING.md에 따른다.

## 참조

- ControlPanel 캐시: https://github.com/craftingmod/ComfyUI-ControlPanel/blob/main/backend/manager_cache.py
- ControlPanel 캐시 배포: https://github.com/craftingmod/ComfyUI-ControlPanel/blob/main/backend/manager_api.py
- ControlPanel 설정 UI: https://github.com/craftingmod/ComfyUI-ControlPanel/blob/main/frontend/src/index.ts
- Manager 최신 버전 소비: https://github.com/Comfy-Org/ComfyUI-Manager/blob/main/glob/manager_core.py
- Manager 버전 목록/설치: https://github.com/Comfy-Org/ComfyUI-Manager/blob/main/glob/cnr_utils.py
- Manager Flagged 설치 허용: https://github.com/Comfy-Org/ComfyUI-Manager/blob/main/glob/manager_util.py
- Registry API 계약: https://github.com/Comfy-Org/registry-backend/blob/main/openapi.yml
