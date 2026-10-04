# OrderDesk Rule Builder 감사 — 실제 룰이 하는 일

2026-09, Kai가 붙여준 Rule Builder 전체 목록(조건만, 액션 미포함)과 확인된 사실을 정리한 것.
`docs/order-lifecycle-and-refunds.md`가 **정책**이라면 이 문서는 **현재 시스템이 실제로 어떻게
동작하는지**의 기록이다. 여기서 나온 사실이 그 문서의 게이트 정의를 확정한다.

⚠️ 최초 붙여넣기에는 **룰 이름과 조건만** 있고 액션이 없었다. 이후 `Address Change`와
`Push Order Address Update to Redis` 두 룰의 화면을 확인해 초판의 오류를 바로잡았다(발견 1·3).
나머지 룰의 액션은 여전히 이름에서 추론한 것이며, "확인 필요" 표시가 붙은 것은 열어보지 않았다.

## 폴더 흐름 (확정)

```
Shopify ──▶ [별도 AWS 코드가 OrderDesk 주문을 갱신하고 옮김] ──▶ QTS 665685
   │
   └── 오피스가 Today(73066) / Tomorrow(73067) 에 넣으면 라우팅 캐스케이드 실행
                    │
                    ▼
        시설 폴더  GA 73068 · NJ 73069 · TX 73070 · NV 674352 · CA 42928
                    │  (생산)
                    ▼
        <시설> Awaiting Shipment   GA 3571 · NJ 43256 · TX 43257 · NV 674353 · CA 79040
                    │  ◀── ★ 이 폴더로 이동하는 순간 OrderDesk가 ShipStation으로 주문 전송
                    ▼
        <시설> Awaiting Pickup / 발송 ──▶ Completed Orders 3516
```

**ShipStation 진입점 = `<시설> Awaiting Shipment` 폴더 이동** (Kai 확인).
해당 룰: `GA Awaiting Shipment`, `NJ Awaiting Shipment`, `TX Awaiting Shipment`,
`NV Awaiting Shipment`, `CA Awaiting Shipment` — 전부 `If Folder Name = <X> Awaiting Shipment`.
각각 `(New Site)` 중복 룰이 있다(왜 둘인지 확인 필요).

## 발견 1 — 주소 변경은 ShipStation으로 간다. 진짜 구멍은 그 앞이다

**초판의 주장(“Address Changed 이벤트에 ShipStation 룰이 없다”)은 틀렸다.** 룰 화면을 열어 확인한 결과:

```
When Order Address Changed...
  · Address Change        필터 없음 (모든 주문)
                          액션: Submit Order to ShipStation          ← 활성
  · Push Order Address Update to Redis  x3   (아래 발견 3)
```

주소가 **OrderDesk 안에서** 바뀌면 폴더와 무관하게 ShipStation으로 재전송된다. 이 경로는 정상이다.

### 그런데 왜 오피스는 여전히 인보이스를 다시 쓰는가

이 룰은 **OrderDesk의 주소가 바뀌어야** 발화한다. 주소 변경이 **Shopify에서** 일어나면
OrderDesk는 그 사실을 모르고(주문 편집분은 연동 앱에 재동기화되지 않는다), 이벤트가 뜨지 않으며,
따라서 ShipStation도 레거시 봇도 갱신되지 않는다.

**구멍은 OrderDesk → ShipStation이 아니라 Shopify → OrderDesk 구간이다.**

이것이 설계에 주는 의미는 오히려 좋다. 고객 수정 페이지가 **OrderDesk에 주소를 쓰기만 하면**
그 뒤 전파(ShipStation, 레거시 봇)는 기존 룰이 전부 알아서 한다. 우리가 ShipStation API를
직접 칠 필요가 없다 — `orderdesk-write.mjs`에 주소 PUT 하나를 추가하는 것으로 끝난다.

### 다만 짚어둘 것 — `Address Change` 룰에는 필터가 하나도 없다

`Order Details Changed`의 대응 룰은 `Order Fulfillment Service = ShipStation`으로 걸러 이미
ShipStation에 있는 주문만 갱신한다. 반면 `Address Change`는 **모든 주문**에 대해
`Submit Order to ShipStation`을 실행한다. 즉 아직 QTS·Proofing 단계인 주문도 주소만 건드리면
ShipStation으로 넘어간다. Kai가 확인한 정상 진입점(`<시설> Awaiting Shipment` 폴더 이동)보다
훨씬 이르다.

- `Submit Order to ShipStation`이 주문번호 기준 upsert면 무해하다.
- 새 레코드를 만든다면 **중복 주문**이 생긴다.
- 어느 쪽이든, 수정 창을 열면 이 룰의 발화 빈도가 크게 올라간다. 열기 전에 확인해야 한다.

## 발견 2 — G2는 두 단계다

| 단계 | 시점 | 의미 |
| --- | --- | --- |
| **G2a** ShipStation 사본 생성 | Awaiting Shipment 폴더 이동 | 주소가 2곳에 존재하기 시작 → **동기화가 필요해지는 지점** |
| **G2b** 라벨 출력 | 공장이 라벨을 뽑음 | **진짜 주소 잠금** → 바코드 스캔 지점 |

G2a~G2b 사이가 "동기화 구간"이다. OrderDesk 안에서의 주소 변경은 이 구간에서 잘 전파되지만
(발견 1), **Shopify에서만 바뀐 주소는 전파되지 않는다.** 그리고 G2b 이후에는 어떤 경로로도
늦다 — ShipStation이 라벨 생성 후 주소 수정을 막고 void/reship이 필요하기 때문이다.
`order-lifecycle-and-refunds.md`의 G2 정의를 이 두 단계로 쪼개야 한다.

### 용어 충돌 — 확인 필요

창고는 *"awaiting shipment에 있지만 실제로 프린트가 시작되지 않은 경우 이미지·주소·shipping 모두
변경해준다"* 고 했다. 그런데 위 폴더 흐름상 `<시설> Awaiting Shipment`는 **생산이 끝난 뒤**다.
둘 중 하나다:

- (a) 창고가 말한 "awaiting shipment"는 **ShipStation의 주문 상태**(라벨 만들기 전 기본 상태)이고,
      OrderDesk 폴더가 아니다
- (b) 창고가 시설 폴더(GA=생산 대기)를 그렇게 부른다

**어느 쪽인지에 따라 G1·G2의 위치가 달라진다.** 창고에 확인해야 한다.

## 발견 3 — “Redis push” 룰은 사실 레거시 봇의 HTTP API를 호출한다

이름은 Redis지만 액션은 HTTP POST다. 룰 화면 확인:

```
Push Order Address Update to Redis
  필터 : Folder ID In List 665685, 651474, 652268, 653109, 657836, 661019
  액션 1: Set Order Metadata Value   json_post_in_body = 1
  액션 2: Post Order JSON
          Destination    https://proof.stickersbanners.com/api/updateOr…   (화면에서 잘림)
          Include History No
          Request Format  Form Data (application/x-www-form-urlencoded)
```

같은 형태의 룰이 네 이벤트에 걸려 있다 — Details Changed / Address Changed / Item Changed /
Note Added. 조건은 모두 “진행 중 폴더에 있을 것”(Job Pool·QTS·Proofing·Manual·Pending Review·
To Sales Rep·Missing File).

### 두 가지가 확정된다

1. **`proof.stickersbanners.com`은 레거시 봇(SBBotExpress)의 API 호스트다.**
   `docs/linh-requirements.md`의 미해결 항목 3(“포털이 어디에 호스팅되는지 모른다”)의 답이다.
   **레거시 봇을 끄면 이 룰 네 개가 전부 죽는다.**
2. **우리 파이프라인에는 이 경로가 없다.** 폴러가 QTS를 한 번 읽어 큐에 넣으면 끝이고,
   그 뒤 OrderDesk에서 무엇이 바뀌어도 모른다. 포팅 누락이며 수정 자동화의 전제 조건이다.

### 이관 방법

네 룰의 **Destination을 우리 API Gateway URL로 바꾸면** 그대로 우리 것이 된다.
`POST /webhook/orderdesk` 라우트와 `webhook` Lambda가 이미 있다. 주의할 점 둘:

- **Request Format이 Form Data**다. 주문 JSON이 `order` 필드에 담겨 온다 —
  현재 webhook Lambda는 JSON 본문을 전제하므로 form-urlencoded 파싱을 추가해야 한다.
- 병존 기간에는 **두 곳으로 보내야** 한다(룰을 복제해 Destination만 다르게).
  레거시 봇이 살아 있는 동안 그쪽 push를 끊으면 실운영이 깨진다.

## 발견 4 — QTS 진입은 룰이 아니라 AWS 코드가 한다

`Order is Imported` 이벤트에는 룰이 하나도 없다. 라우팅은 전부 `When Folder is Changed` 기반이고
조건이 `Folder Name = Today` / `Tomorrow`다 — 즉 **오피스가 Today/Tomorrow 폴더에 넣는 행위가
라우팅의 트리거**다.

그리고 Kai 확인: **Shopify 주문을 OrderDesk에서 갱신하고 QTS 폴더로 옮기는 것은 별도의 AWS 코드다.**
룰도, Shopify 통합의 다운로드 폴더 설정도 아니다. (OrderDesk 통합 목록에 `Amazon Web Services`가
연결되어 있는 것과 연결된다.)

### 설계에 주는 영향 — 수정 홀드가 훨씬 단순해진다

`docs/order-lifecycle-and-refunds.md`의 D3은 “신규 주문을 Modification Hold 폴더로 보내는
OrderDesk 룰”을 1차 방어선으로 삼았다. **더 이상 필요 없다.** QTS로 옮기는 코드가 이미 우리 쪽에
있다면, **수정 창이 열려 있는 동안 그 이동을 하지 않으면 그만이다.** 새 폴더도, 새 룰도,
시간 기반 릴리스 룰도 없이 조건문 하나로 끝난다.

⚠️ **단 그 코드는 이 리포에 없다.** 이 리포의 폴러는 QTS를 **읽기만** 하고
`ORDERDESK_WRITES`는 꺼져 있다. 어느 코드베이스인지 확인이 필요하다 — 이번 작업이 그 코드를
고치는 일인지, 이 리포에서 새로 하는 일인지가 갈린다.

## 발견 5 — 시간 기반 조건이 가능하다

```
Send orders to CA : If Folder Name = CA and If Order Date Updated before time -5 minutes
STP Today         : If Folder Name = STP and If Current Hour > 15:00
STP Tomorrow      : If Folder Name = STP and If Current Hour < 15:00
```

`Order Date Updated before time -5 minutes`는 **디바운스**다 — 마지막 수정 후 5분이 지나야 CA 스토어로 보낸다.
수정 창의 자동 종료를 **우리 코드 없이 OrderDesk가 처리할 수 있다는 뜻**이고,
심지어 "고객이 계속 만지는 동안은 안 넘긴다"는 우리가 원하던 동작이 이미 구현되어 있다.

`Current Hour > 15:00`은 Linh의 3–6pm ET 익스프레스 컷오프와 같은 시각이다.

## 발견 6 — ShipStation은 GA / NJ / TX만

```
Ship From GA : Order Metadata Field shipstation_store_id = 68977
Ship From NJ : Order Metadata Field shipstation_store_id = 68987
Ship From TX : Order Metadata Field shipstation_store_id = 68986
```

NV·CA에 해당하는 store id가 없다. CA는 **별도 OrderDesk 스토어**로 넘어간다
(`Send orders to CA`, `send order to SB_CA`, `Copy to SB_CA`, `SB_CA (keep original item id)`).

→ 바코드 스캔/라벨 프로젝트는 **GA·NJ·TX만 ShipStation 경로**이고, CA·NV는 별도 확인이 필요하다.
단 `CA Awaiting Shipment` 룰은 존재하므로 CA도 어딘가로 보내고 있다 — 확인 필요.

## 발견 7 — 애드온 메커니즘이 이미 있다

```
Adding 8' Stand           : Item Variation STAND = S8
Adding 8' pop up display  : Item Variation STAND = S115
Adding 10' pop up display : Item Variation STAND = S145
Adding 8' Carpet          : Item Variation CARPET = C8
Adding 10' Carpet         : Item Variation CARPET = C10
Removing Item Variation (STAND / CARPET / SPECIAL INSTRUCTIONS / DUE DATE) if blank
```

애드온은 **line item의 variation(STAND / CARPET)으로 들어오고 룰이 하드웨어 라인으로 펼친다.**
고객 수정 페이지가 새 메커니즘을 만들 필요 없이 이 variation을 세팅하면 된다.
(단 이 룰들은 `z.Test` 커스텀 버튼 아래에 있어 수동 트리거로 보인다 — 자동 경로인지 확인 필요.)

## 우리 코드와의 불일치

`src/shared/routing.mjs`를 실제 룰과 대조한 결과. **실주문의 생산지가 바뀌는 문제이므로
Linh 확인 전에는 코드를 고치지 않는다**(기존 원칙).

| # | OrderDesk 실제 룰 | `routing.mjs` | 영향 |
| --- | --- | --- | --- |
| 1 | TX 주 목록에 **MT 포함** (`...KS,LA,MT,MO,...`), NV 목록에도 MT | MT는 NV에만 | 몬태나 주문의 생산지. OrderDesk에서도 두 룰에 모두 걸려 실행 순서에 따라 결과가 달라진다 |
| 2 | `CA to TX See through order to Texas for sales rep` — CA 폴더 + See Thru + 픽업 아님 → TX | see-thru → **NV** | `docs/linh-requirements.md`의 "see-thru는 NV" 와도 다름 |
| 3 | `Sticker back to GA` — NJ/TX/CA/NV 폴더의 STICKER 품목 → GA | sticker → sales 폴더(특수 상품 게이트) | 두 규칙이 서로 다른 단계일 수 있음 |
| 4 | `Double-Sided X-Banners back to GA` — TX/CA 폴더 | 없음 | 미구현 |
| 5 | `Weather TX Express to GA` — TX 폴더 + 특정 배송 제외 | 없음 | 이름상 한시적 룰인데 살아 있음 |
| 6 | `Today - NV (Copy)` 조건에 **CA 추가**, `Tomorrow - CA` 조건은 NV 주 목록 + CA | 해당 없음 | 룰 이름과 조건이 어긋나 있음 |

**MT(1번)가 가장 시급하다.** Linh가 준 TX 목록에는 MT가 없었는데 실제 룰에는 있다.

### 중복 룰

`(Copy)` / `(New Site)` 접미사 룰이 매우 많다 (`Approved from the website (Copy) (Copy)`,
`GA Awaiting Shipment (New Site)`, `Proof (New Site)`, `Order is Shipped (New Site)` 등).
둘 다 실행되는지, 하나는 죽은 룰인지 확인이 필요하다. 우리가 룰을 추가하기 전에 정리되어야
어떤 룰이 실제 경로인지 판단할 수 있다.

## 커스텀 버튼 = 스태프의 수동 액션

| 버튼 | 룰 | 우리 파이프라인 대응 |
| --- | --- | --- |
| `a.Proof` | Proof / Proof (New Site) | 프루프 생성 |
| `b.Low Resolution` | Low Resolution | 인테이크 게이트 `missing-file` 계열 |
| `c.No File` | No File | 인테이크 게이트 `missing-file` |
| `d. CA` | Copy to SB_CA / Cancel order | CA 스토어 이관 |
| `e. approved` | proof approved | 프루프 승인 |
| `f. STP` | STP | Pickup Station 경로 |
| `Reprint` | Reprint | 재인쇄 |

인테이크 게이트가 주문을 사람에게 넘긴 뒤, 사람이 이 버튼들로 처리한다.
**환불 이유 카테고리를 만들 때 이 버튼 목록이 실제 예외 유형의 근거가 된다.**

## 아직 확인해야 할 것

| # | 내용 | 왜 |
| --- | --- | --- |
| 1 | **QTS로 옮기는 AWS 코드가 어느 코드베이스인가** | 수정 홀드를 어디에 넣을지. 이 리포가 아니다 |
| 2 | `Post Order JSON` Destination의 **전체 URL** (화면에서 잘림) | 이관 대상 엔드포인트 확정 |
| 3 | `Submit Order to ShipStation`이 주문번호 기준 **upsert인가 신규 생성인가** | 중복 주문 위험 |
| 4 | Shopify 통합 설정 — financial status / fulfillment status / vendor 필터 | 다운로드 조건 |
| 5 | 창고의 "awaiting shipment"가 OrderDesk 폴더인가 ShipStation 상태인가 | G1·G2 위치 |
| 6 | `(New Site)` / `(Copy)` 중복 룰 — 둘 다 도는가 | 룰 추가 전 정리 필요 |
| 7 | CA·NV의 라벨 출력 경로 | ShipStation store id가 없다 |
| 8 | MT가 실제로 어디로 가는가 (실주문 확인) | 불일치 1번 |
