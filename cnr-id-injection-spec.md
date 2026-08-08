# ComfyUI 커스텀 노드용 `cnr_id` 주입 기능 명세

## 1. 목적

이 문서는 ComfyUI 웹 프런트엔드 확장을 포함하는 커스텀 노드를 구현하여 워크플로 노드의 `properties`에 다음 메타데이터를 기록하는 데 필요한 동작과 구현 조건을 정의한다.

- `cnr_id`: Comfy Registry의 노드 팩 식별자
- `aux_id`: Registry ID가 없는 팩의 보조 식별자
- `ver`: 현재 설치된 노드 팩 또는 ComfyUI Core 버전

구현해야 할 사용자 기능은 두 가지다.

1. **Fix cnr_id 버튼**: 현재 워크플로를 검사하여 메타데이터를 수동으로 추가하거나 교정한다.
2. **자동 주입**: 새 노드가 생성될 때 메타데이터를 자동으로 추가한다. 불러온 워크플로에 대한 보정도 별도 정책으로 고려한다.

이 기능의 주목적은 워크플로를 다른 환경으로 옮겼을 때 누락된 커스텀 노드 팩과 버전을 식별할 수 있게 하는 것이다. 실행 프롬프트의 동작에는 영향을 주지 않아야 한다.

## 2. 기준 환경과 확인된 현상

이 명세는 다음 조합을 기준으로 작성되었다.

- ComfyUI `0.31.1`
- ComfyUI Frontend `1.48.7`
- `comfyui-manager==4.2.2`
- Manager 신규 UI: `python main.py --enable-manager`

실행 환경에서 확인된 사항은 다음과 같다.

- `GET /v2/customnode/installed`는 정상 작동하며 설치 팩별 `cnr_id`, `aux_id`, `ver`, `enabled`를 반환한다.
- `GET /v2/manager/is_legacy_manager_ui`는 신규 UI에서 `false`를 반환한다.
- `comfyui-manager 4.2.2`의 `workflow-metadata.js`에는 필요한 주입 로직이 존재한다.
- 그러나 해당 JS 디렉터리는 `--enable-manager-legacy-ui`일 때만 프런트엔드 확장으로 등록된다.
- 신규 Manager UI 자체는 기존 `cnr_id`를 읽는 기능은 있지만 노드 생성 시 기록하는 동등한 로직은 제공하지 않는다.

따라서 이 커스텀 노드는 신규 Manager UI를 유지하면서 누락된 주입 기능만 독립적으로 제공하는 것을 목표로 한다.

## 3. 범위

### 포함

- 현재 활성 워크플로의 일반 노드와 서브그래프 내부 노드 검사
- Core 노드와 Python 커스텀 노드의 출처 판별
- Manager의 로컬 API를 이용한 설치 팩 매핑
- `cnr_id`, `aux_id`, `ver` 기록
- 새 노드 자동 주입
- 불러온 노드에 대한 누락값 보충 정책
- 수동 전체 검사 및 교정
- 변경 결과 요약, 오류 표시, Undo/Redo 호환
- Manager 신규 UI와 레거시 UI 모두에서 안전한 중복 실행

### 제외

- Registry 또는 GitHub에 직접 인터넷 요청
- 누락된 노드 팩 설치
- 워크플로 실행 프롬프트 변경
- 노드 타입명이나 표시 이름만으로 팩을 추측하는 기능
- Registry에 없는 팩에 임의의 `cnr_id`를 생성하는 기능
- 서버의 워크플로 JSON을 저장 시점에 변조하는 기능

## 4. 신뢰할 수 있는 데이터 원천

### 4.1 설치 팩 매핑

우선 사용할 API:

```http
GET /v2/customnode/installed
```

레거시 호환용 선택적 fallback:

```http
GET /customnode/installed
```

fallback은 `/v2/customnode/installed`가 `404`일 때만 시도하는 것이 권장된다. 인증 실패, 서버 오류, 네트워크 오류를 레거시 API로 숨기지 않는다.

응답의 개념적 형태:

```json
{
  "anima-safe-pag": {
    "ver": "0.1.0",
    "cnr_id": "anima-safe-pag",
    "aux_id": null,
    "enabled": true
  },
  "some-nightly-package": {
    "ver": "<git commit 또는 Manager가 제공하는 버전 문자열>",
    "cnr_id": null,
    "aux_id": "author/repository",
    "enabled": true
  }
}
```

`ver`는 의미를 재해석하지 않는 불투명 문자열로 취급한다. 값이 문자열이면 앞뒤 공백만 제거하고 그대로 기록한다.

### 4.2 ComfyUI Core 버전

```http
GET /system_stats
```

사용할 필드:

```text
response.system.comfyui_version
```

### 4.3 노드 출처

각 노드 인스턴스에서 다음 값을 사용한다.

```js
node.constructor.nodeData.python_module
```

예:

```text
nodes
comfy_extras.nodes_upscale_model
comfy_api_nodes.nodes_openai
custom_nodes.anima-safe-pag
custom_nodes.ComfyUI-KJNodes.nodes.image
```

다음 값은 출처 판별에 사용하면 안 된다.

- `node.type`
- `node.title`
- 화면에 보이는 노드 이름
- 카테고리
- Python 클래스 이름만 사용한 검색

동일한 타입명이나 표시 이름을 여러 팩이 제공할 수 있기 때문이다.

## 5. 주입 규칙

### 5.1 공통 전제

노드에 `python_module`이 없으면 처리하지 않는다. 여기에는 누락 노드 placeholder, 일부 프런트엔드 전용 노드 및 특수 서브그래프 노드가 포함될 수 있다.

필요할 때만 다음과 같이 `properties`를 생성한다.

```js
const properties = (node.properties ??= {})
```

### 5.2 Core 노드

`python_module`의 첫 세그먼트가 다음 중 하나이면 Core 노드로 간주한다.

```text
nodes
comfy_extras
comfy_api_nodes
```

목표값:

```json
{
  "cnr_id": "comfy-core",
  "ver": "<system.comfyui_version>"
}
```

Core 노드에는 `aux_id`를 남기지 않는다.

### 5.3 커스텀 노드

`python_module`이 `custom_nodes.`로 시작하면 두 번째 세그먼트를 Manager 설치 맵의 키로 사용한다.

```js
const packageKey = pythonModule.split('.')[1]
```

조회 순서:

1. 원문 키 정확히 일치
2. 소문자 키 일치

Manager 4.2.2의 기존 로직과 호환하기 위한 규칙이다. 초기화 시 소문자 alias 맵을 만들 수 있지만, 소문자 변환 후 서로 다른 두 키가 충돌하면 어느 쪽도 자동 선택하지 않고 `ambiguous`로 보고해야 한다.

#### Registry 팩

설치 맵에 유효한 `cnr_id`가 있으면:

```json
{
  "cnr_id": "<installed.cnr_id>",
  "ver": "<installed.ver>"
}
```

- 기존 `aux_id`는 삭제한다.
- 커스텀 노드 매핑이 `cnr_id: "comfy-core"`를 주장하면 적용하지 않는다. Core 이름 탈취 방지 규칙이다.

#### Registry ID가 없는 팩

`cnr_id`는 없고 유효한 `aux_id`가 있으면:

```json
{
  "aux_id": "<installed.aux_id>",
  "ver": "<installed.ver>"
}
```

- 수동 Fix의 authoritative 모드에서는 기존 `cnr_id`를 삭제한다.
- 자동 fill-missing 모드에서는 기존 식별자를 함부로 삭제하지 않는다.

#### 매핑 실패

설치 맵에서 패키지를 찾지 못했거나 `cnr_id`와 `aux_id`가 모두 없으면:

- 임의 값을 기록하지 않는다.
- 기존 `cnr_id`, `aux_id`, `ver`를 삭제하지 않는다.
- 결과를 `unresolved`로 집계한다.

### 5.4 기타 Python 모듈

첫 세그먼트가 Core 목록이나 `custom_nodes`가 아니면 자동 처리하지 않는다. 새로운 공식 모듈 네임스페이스가 생긴 경우 명시적인 허용 목록 업데이트 후 지원한다.

## 6. 적용 모드

하나의 판별 함수와 두 가지 적용 정책을 구현하는 것이 권장된다.

### 6.1 `fill-missing`

자동 주입용 기본 정책이다.

- 없는 `cnr_id` 또는 `aux_id`만 채운다.
- 식별자가 새로 기록되거나 현재 식별자와 동일할 때 `ver`를 현재 설치 버전으로 채운다.
- 다른 기존 식별자는 덮어쓰지 않는다.
- 충돌은 콘솔 경고 또는 내부 집계만 하고 자동 수정하지 않는다.

목적은 사용자가 기존 워크플로를 열기만 해도 예상하지 못한 대규모 변경이 발생하는 것을 줄이는 것이다.

### 6.2 `repair`

**Fix cnr_id** 버튼용 정책이다.

- 신뢰할 수 있는 매핑이 있으면 현재 식별자를 authoritative 값으로 교체한다.
- `cnr_id`와 `aux_id`가 동시에 남지 않도록 반대 필드를 삭제한다.
- `ver`를 현재 설치 상태에 맞게 갱신한다.
- 매핑 실패 노드의 기존 메타데이터는 보존한다.
- 적용 전후 값이 같으면 변경으로 계산하지 않는다.

버튼 이름이 `Fix`이므로 단순 누락값 추가뿐 아니라 잘못되거나 오래된 매핑의 교정까지 수행해야 한다. 다만 추측에 기반한 삭제는 하지 않는다.

## 7. 자동 주입 생명주기

### 7.1 `init(app)`

프런트엔드 확장 초기화 시 다음 작업을 완료한다.

1. `/v2/customnode/installed` 조회
2. `/system_stats` 조회
3. 설치 팩 exact 맵과 lowercase alias 맵 생성
4. Core 버전 캐시
5. 준비 상태를 `ready`, `degraded`, `unavailable` 중 하나로 설정

ComfyUI는 `init`을 캔버스 생성 후 노드 추가 전에 호출하므로 이 단계에서 비동기 조회를 끝내는 것이 중요하다.

### 7.2 `nodeCreated(node)`

대화형으로 새 노드가 만들어질 때 `fill-missing` 정책을 동기적으로 적용한다.

중요한 제약:

- 현재 프런트엔드는 생성자에서 `invokeExtensionsAsync('nodeCreated', node)`를 `await`하지 않고 호출한다.
- 따라서 `nodeCreated` 안에서 API 조회를 시작하면 사용자가 즉시 저장할 때 주입이 늦을 수 있다.
- 모든 API 데이터는 반드시 `init`에서 미리 캐시하고, `nodeCreated`에서는 캐시만 사용해야 한다.
- 캐시가 준비되지 않았으면 해당 노드를 pending 집합에 넣고 초기화 성공 후 한 번 재처리한다.

### 7.3 불러온 워크플로와 `loadedGraphNode(node)`

노드 생성자는 직렬화된 데이터의 `configure`보다 먼저 실행될 수 있다. 불러온 워크플로의 `properties`가 이후 configure 단계에서 복원되므로 `nodeCreated`만으로는 로드된 노드를 확실히 보정할 수 없다.

권장 동작:

- `nodeCreated`: 새 노드에 `fill-missing`
- `loadedGraphNode`: configure 이후 다시 `fill-missing`
- 수동 버튼: 모든 로드가 완료된 현재 그래프에 `repair`

`loadedGraphNode`에서는 기존 식별자를 강제 교체하지 않는다. 오래된 워크플로를 열기만 해도 즉시 대량 수정되는 것을 막기 위해서다.

### 7.4 저장 직전 보정

초기 버전에서는 저장 함수를 monkey-patch하지 않는 것이 권장된다. 저장 경로는 프런트엔드 버전에 따라 바뀔 수 있고 다른 확장과 충돌하기 쉽다.

다음 조건이 실제 테스트에서 발견될 때만 저장 직전 보정을 추가한다.

- `nodeCreated`가 완료되기 전에 저장되는 재현 가능한 경쟁 조건
- 외부 확장이 hook을 거치지 않고 노드를 삽입하는 경우

추가한다면 공개된 프런트엔드 extension hook 또는 command/service 경계를 우선 사용하고, `app.graph.serialize` 자체를 덮어쓰지 않는다.

## 8. Fix cnr_id 버튼 요구사항

### 8.1 배치 위치

신규 프런트엔드의 `ComfyExtension.actionBarButtons`를 우선 사용한다.

권장 표시:

- Label: `Fix cnr_id`
- Tooltip: `Add or repair Comfy Registry metadata in the active workflow`
- Icon: 적절한 repair/tag 계열 Lucide 아이콘

버튼 API가 없는 구버전 지원이 필요하면 `commands`와 `menuCommands`로 동일 명령을 노출한다. DOM에 임의의 버튼을 직접 삽입하는 방식은 레이아웃 변경에 취약하므로 최후의 fallback으로만 사용한다.

### 8.2 대상 범위

기본 동작은 **현재 활성 워크플로 전체**다.

- 루트 그래프의 모든 노드
- 모든 중첩 서브그래프 내부 노드
- 한 노드를 두 번 방문하지 않도록 visited 집합 사용

선택 노드만 고치는 기능은 별도 context-menu 명령으로 추가할 수 있지만, 기본 버튼 의미에 포함시키지 않는다.

### 8.3 실행 절차

1. 버튼 클릭 시 설치 팩 맵과 Core 버전을 새로고침한다.
2. API 조회가 실패하면 그래프를 변경하지 않고 오류를 표시한다.
3. 모든 대상 노드에 대해 변경 계획을 계산한다.
4. 변경이 있을 때 그래프의 `beforeChange()`를 한 번 호출한다.
5. 모든 변경을 적용한다.
6. `setDirtyCanvas(true, true)`와 `afterChange()`를 호출한다.
7. 결과 toast 또는 dialog를 표시한다.

한 노드마다 Undo 항목을 만들지 않고 전체 Fix 작업을 하나의 Undo 가능한 변경으로 묶는다.

### 8.4 결과 요약

최소한 다음 수치를 표시한다.

```text
Updated: 12
Already correct: 8
Unresolved: 3
Skipped: 2
Conflicts preserved: 1
```

`unresolved` 상세에는 다음 정보만 포함한다.

- node id
- node type
- `python_module`
- 실패 원인: `package-not-found`, `no-package-id`, `ambiguous-key`, `invalid-core-claim`, `missing-python-module`

경로, 토큰 또는 Manager 내부 설정 전체를 UI에 노출하지 않는다.

## 9. 변경 판정 표

| 노드 분류 | 설치 매핑 | 자동 `fill-missing` | 수동 `repair` |
|---|---|---|---|
| Core | Core 버전 있음 | 누락값 추가 | `comfy-core`와 현재 Core 버전으로 교정 |
| Custom | `cnr_id` 있음 | 식별자가 없을 때 추가 | `cnr_id`로 교정, `aux_id` 제거 |
| Custom | `aux_id`만 있음 | 식별자가 없을 때 추가 | `aux_id`로 교정, `cnr_id` 제거 |
| Custom | 매핑 없음 | 보존, unresolved | 보존, unresolved |
| Custom | `cnr_id=comfy-core` 주장 | 적용 안 함 | 적용 안 함, 보안 경고 |
| Frontend-only/Unknown | 없음 | skip | skip |
| Missing node placeholder | 직렬화 데이터만 있음 | 보존 | 보존, unresolved 가능 |

## 10. 권장 내부 구조

```text
custom_nodes/comfyui-cnr-metadata-fixer/
├─ __init__.py
└─ js/
   ├─ cnr-metadata.js
   ├─ metadata-service.js
   ├─ graph-walker.js
   └─ ui.js
```

Python 쪽에는 실행 노드가 필요하지 않다.

```python
WEB_DIRECTORY = "./js"

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
```

권장 책임 분리:

- `metadata-service.js`
  - API 조회, 캐시, 키 정규화
  - `resolveNodeMetadata(node)`
- `graph-walker.js`
  - 루트 그래프와 서브그래프 순회
- `cnr-metadata.js`
  - extension 등록
  - `init`, `nodeCreated`, `loadedGraphNode`
  - 변경 계획 및 적용 정책
- `ui.js`
  - action bar button, command, toast/dialog

## 11. 핵심 인터페이스 예시

```js
/**
 * @typedef {Object} InstalledPack
 * @property {string|null|undefined} cnr_id
 * @property {string|null|undefined} aux_id
 * @property {string|null|undefined} ver
 * @property {boolean|undefined} enabled
 */

/**
 * @typedef {Object} ResolvedMetadata
 * @property {'core'|'custom'|'unknown'} source
 * @property {string=} cnrId
 * @property {string=} auxId
 * @property {string=} version
 * @property {string=} packageKey
 * @property {string=} reason
 */
```

판별 함수는 그래프를 직접 변경하지 않고 결과만 반환해야 한다.

```js
function resolveNodeMetadata(node, metadataCache) {
  const pythonModule = node?.constructor?.nodeData?.python_module
  if (typeof pythonModule !== 'string' || !pythonModule) {
    return { source: 'unknown', reason: 'missing-python-module' }
  }

  const [moduleType, packageKey] = pythonModule.split('.')

  if (['nodes', 'comfy_extras', 'comfy_api_nodes'].includes(moduleType)) {
    return {
      source: 'core',
      cnrId: 'comfy-core',
      version: metadataCache.comfyCoreVersion
    }
  }

  if (moduleType !== 'custom_nodes' || !packageKey) {
    return { source: 'unknown', reason: 'unsupported-module' }
  }

  const pack = metadataCache.lookupPackage(packageKey)
  if (!pack) {
    return { source: 'custom', packageKey, reason: 'package-not-found' }
  }

  if (pack.cnr_id === 'comfy-core') {
    return { source: 'custom', packageKey, reason: 'invalid-core-claim' }
  }

  if (typeof pack.cnr_id === 'string' && pack.cnr_id) {
    return {
      source: 'custom',
      packageKey,
      cnrId: pack.cnr_id,
      version: normalizeVersion(pack.ver)
    }
  }

  if (typeof pack.aux_id === 'string' && pack.aux_id) {
    return {
      source: 'custom',
      packageKey,
      auxId: pack.aux_id,
      version: normalizeVersion(pack.ver)
    }
  }

  return { source: 'custom', packageKey, reason: 'no-package-id' }
}
```

적용 함수는 모드에 따라 변경 계획을 만든다.

```js
function planMetadataChange(node, resolved, mode) {
  // mode: 'fill-missing' | 'repair'
  // 반환값은 before/after와 changed 여부를 포함한다.
  // unresolved 상태에서는 기존 값을 삭제하지 않는다.
}
```

## 12. 중복 확장 및 호환성

### 12.1 레거시 Manager와 동시 사용

레거시 Manager가 활성화되어 있으면 공식 `workflow-metadata.js`도 같은 값을 주입한다.

요구사항:

- 같은 값에 대한 재적용은 완전한 no-op이어야 한다.
- `nodeCreated`에서 동일 값이면 그래프 변경 이벤트를 발생시키지 않는다.
- 확장 로드 순서에 의존하지 않는다.
- 공식 확장 존재 여부 탐지가 가능하면 자동 주입을 비활성화할 수 있지만, 비공개 내부 API에 의존하는 탐지는 필수로 만들지 않는다.

### 12.2 Manager 미설치 또는 비활성화

- Core 메타데이터만 `/system_stats`로 계산할 수 있더라도, 사용자가 전체 Fix를 요청했을 때 커스텀 노드 매핑 실패를 명확히 알려야 한다.
- 권장 기본값은 Manager API가 없으면 전체 Fix를 중단하는 것이다.
- 선택 설정으로 `Fix core nodes even without Manager`를 제공할 수 있다.

### 12.3 프런트엔드 버전

- `actionBarButtons`, `commands`, `menuCommands`, `nodeCreated`, `loadedGraphNode`의 존재 여부를 대상 최소 버전에서 확인한다.
- 지원 최소 버전을 README와 `pyproject.toml` 설명에 명시한다.
- DOM 구조나 minified bundle 이름에 의존하지 않는다.

## 13. 상태와 오류 처리

권장 상태:

```text
idle -> loading -> ready
                -> degraded
                -> unavailable
```

- `ready`: 설치 팩 맵과 Core 버전 모두 준비됨
- `degraded`: 둘 중 하나만 준비됨
- `unavailable`: 신뢰할 수 있는 데이터가 없음

API 오류 시:

- `nodeCreated`에서 반복적으로 요청하지 않는다.
- 콘솔을 노드 수만큼 도배하지 않는다.
- 한 번의 간결한 경고와 버튼 실행 시 사용자 메시지를 제공한다.
- Fix 버튼은 명시적 재시도를 수행한다.

캐시 무효화 시점:

- 페이지 초기화
- Fix 버튼 클릭
- 선택적으로 Manager 설치/업데이트 작업 완료 이벤트 수신 시

시간 기반으로 외부 요청을 반복하는 polling은 필요하지 않다.

## 14. 보안 및 데이터 무결성

- 모든 요청은 동일 출처의 ComfyUI 로컬 API에만 `api.fetchApi`로 보낸다.
- Registry나 GitHub에 직접 요청하지 않는다.
- 서버 응답을 신뢰하기 전에 필드 타입을 확인한다.
- `cnr_id`, `aux_id`, `ver`는 문자열만 기록한다.
- 프로토타입 오염을 피하도록 응답 맵을 `Map` 또는 prototype 없는 객체로 정규화한다.
- `__proto__`, `constructor`, `prototype` 같은 위험 키를 일반 객체에 직접 병합하지 않는다.
- `node.properties`의 다른 사용자/확장 필드는 보존한다.
- `cnr_id`, `aux_id`, `ver` 외의 필드는 이 기능이 변경하지 않는다.
- 커스텀 노드가 `comfy-core`를 주장하는 매핑은 거부한다.

## 15. 성능 요구사항

- 설치 팩 API는 자동 주입 시 노드마다 호출하지 않고 페이지당 한 번 캐시한다.
- 패키지 조회는 `Map`을 사용하여 노드당 평균 O(1)이어야 한다.
- 수동 Fix 전체 복잡도는 노드 수 N에 대해 O(N)이어야 한다.
- 수천 노드 워크플로에서도 UI가 장시간 멈추지 않도록 큰 그래프는 chunk 단위로 처리할 수 있다.
- 실제 변경 노드가 0개면 Undo 스냅샷과 dirty 상태를 만들지 않는다.

## 16. 테스트 요구사항

### 16.1 단위 테스트

1. `nodes.*`가 `comfy-core`로 해석된다.
2. `comfy_extras.*`가 `comfy-core`로 해석된다.
3. `comfy_api_nodes.*`가 `comfy-core`로 해석된다.
4. `custom_nodes.Example.nodes`가 exact 키로 조회된다.
5. exact 실패 후 lowercase 키로 조회된다.
6. lowercase 충돌은 ambiguous 처리된다.
7. custom 매핑의 `cnr_id=comfy-core`는 거부된다.
8. `cnr_id`가 있으면 `aux_id`보다 우선한다.
9. `ver` 앞뒤 공백만 제거된다.
10. `python_module`이 없는 노드는 skip된다.
11. `fill-missing`은 다른 기존 식별자를 덮어쓰지 않는다.
12. `repair`는 authoritative 식별자로 교체한다.
13. unresolved 노드의 기존 메타데이터는 보존된다.
14. 같은 값을 다시 적용하면 changed=false다.

### 16.2 통합 테스트

#### 신규 Manager UI

실행:

```text
python main.py --enable-manager
```

검증:

- 새 Core 노드 생성 후 저장 JSON에 `cnr_id=comfy-core`, Core `ver`가 존재한다.
- Registry 등록 커스텀 노드 생성 후 저장 JSON에 해당 `cnr_id`, `ver`가 존재한다.
- 기존 누락 워크플로에서 Fix 버튼 실행 후 값이 추가된다.

#### 레거시 Manager UI

실행:

```text
python main.py --enable-manager --enable-manager-legacy-ui
```

검증:

- 공식 주입 확장과 동시에 로드되어도 결과가 동일하다.
- 중복 Undo 항목이나 반복 dirty 이벤트가 발생하지 않는다.

#### Manager 없음

검증:

- 자동 주입 실패가 ComfyUI 사용 자체를 막지 않는다.
- Fix 버튼은 커스텀 매핑을 수행할 수 없음을 명확히 알린다.
- 기존 메타데이터를 삭제하지 않는다.

#### 워크플로 로드

- `properties`가 전혀 없는 노드
- 올바른 기존 `cnr_id`
- 잘못된 기존 `cnr_id`
- `aux_id`만 있는 노드
- 누락 노드 placeholder
- 서브그래프 내부 노드
- 복사/붙여넣기로 생성된 노드
- 노드 템플릿에서 생성된 노드

### 16.3 저장 JSON 합격 기준

Core 예:

```json
{
  "type": "SaveImage",
  "properties": {
    "cnr_id": "comfy-core",
    "ver": "0.31.1"
  }
}
```

Registry 커스텀 노드 예:

```json
{
  "type": "AnimaSafePAG",
  "properties": {
    "cnr_id": "anima-safe-pag",
    "ver": "0.1.0"
  }
}
```

비등록 팩 예:

```json
{
  "type": "ExampleNode",
  "properties": {
    "aux_id": "author/example-repository",
    "ver": "<manager-provided-version>"
  }
}
```

## 17. 완료 조건

다음 조건을 모두 만족하면 초기 구현을 완료한 것으로 본다.

- 신규 Manager UI에서 새 Core/커스텀 노드의 저장 JSON에 올바른 메타데이터가 존재한다.
- Fix 버튼이 현재 워크플로와 서브그래프를 모두 처리한다.
- 매핑 실패 시 추측하거나 기존 값을 삭제하지 않는다.
- Fix 전체 작업이 하나의 Undo로 되돌려진다.
- 올바른 값에 대한 재실행은 no-op이다.
- 레거시 Manager와 동시에 사용해도 결과가 안정적이다.
- Manager API 실패가 ComfyUI 시작이나 일반 노드 작업을 막지 않는다.
- 단위 및 통합 테스트가 위 시나리오를 포함한다.

## 18. 구현 우선순위

### 1차

- API 캐시
- 출처 판별 및 메타데이터 resolve
- `nodeCreated`의 `fill-missing`
- 전체 워크플로 Fix 버튼의 `repair`
- 기본 toast 결과

### 2차

- `loadedGraphNode` 보정
- 서브그래프 재귀 순회 강화
- Undo/Redo 통합 검증
- 레거시 Manager 중복 동작 테스트

### 3차

- 선택 노드 Fix context menu
- 상세 미리보기
- Manager 작업 완료 이벤트 기반 캐시 갱신
- 다국어 UI 문자열

## 19. 참고 자료

- [ComfyUI-Manager 공식 설치 문서](https://docs.comfy.org/manager/install)
- [ComfyUI 저장소](https://github.com/Comfy-Org/ComfyUI)
- [ComfyUI Frontend 저장소](https://github.com/Comfy-Org/ComfyUI_frontend)
- [ComfyUI-Manager 저장소](https://github.com/Comfy-Org/ComfyUI-Manager)
- [comfyui-manager 4.2.2 PyPI](https://pypi.org/project/comfyui-manager/4.2.2/)

