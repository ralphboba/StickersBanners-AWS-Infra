# OrderDesk Rule Builder 감사 — 실제 룰이 하는 일

2026-09, Kai가 붙여준 Rule Builder 전체 목록(조건만, 액션 미포함)과 확인된 사실을 정리한 것.
`docs/order-lifecycle-and-refunds.md`가 **정책**이라면 이 문서는 **현재 시스템이 실제로 어떻게
동작하는지**의 기록이다. 여기서 나온 사실이 그 문서의 게이트 정의를 확정한다.

⚠️ 붙여넣기에는 **룰 이름과 조건만** 있고 액션이 없다. 액션은 이름과 확인된 사실로부터의 추론이며,
아래 "확인 필요" 표시가 붙은 것은 아직 열어보지 않았다.

## 폴더 흐름 (확정)

```
Shopify ──▶ (다운로드 폴더 — 통합 설정, 룰 아님) ──▶ QTS 665685
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

## 발견 1 — 주소 변경이 ShipStation으로 전파되지 않는다

```
When Order Details Changed...
  · update the info to Shipstation      If Order Fulfillment Service = ShipStation   ✅ 있음

When Order Address Changed...
  · Address Change                      (모든 주문)          ← 액션 확인 필요
  · Push Order Address Update to Redis  x3                    (레거시 봇용)
                                        ❌ ShipStation 갱신 룰 없음
```

**이것이 오피스가 인보이스를 다시 쓰는 원인일 가능성이 매우 높다.** 주문이 Awaiting Shipment에
들어가 ShipStation에 사본이 생긴 뒤 주소를 바꾸면, OrderDesk만 바뀌고 ShipStation은 옛 주소를 들고 있다.
공장은 ShipStation에서 라벨을 뽑으므로 틀린 주소가 인쇄된다.

### 수정안

`update the info to Shipstation` 룰을 **같은 조건(`Order Fulfillment Service = ShipStation`)으로
`When Order Address Changed` 이벤트에 복제한다.** 새로 만드는 게 아니라 기존 룰의 복사다.

- 코드 변경 없음. OrderDesk 설정 변경 하나.
- 하루 10건 중 **주소 변경 건이 여기서 대부분 해결된다.**
- 검증 필요: OrderDesk의 ShipStation 갱신 액션이 **주소 필드까지** 밀어주는가.
  밀지 않으면 우리가 ShipStation API를 직접 쳐야 한다.
- 한계: **라벨이 이미 출력된 뒤에는 소용없다.** ShipStation은 라벨 생성 후 주소 수정을 막고,
  void 또는 reship이 필요하다 → 그래서 G2는 "라벨 출력"이지 "ShipStation 전송"이 아니다.

## 발견 2 — G2는 두 단계다

| 단계 | 시점 | 의미 |
| --- | --- | --- |
| **G2a** ShipStation 사본 생성 | Awaiting Shipment 폴더 이동 | 주소가 2곳에 존재하기 시작 → **동기화가 필요해지는 지점** |
| **G2b** 라벨 출력 | 공장이 라벨을 뽑음 | **진짜 주소 잠금** → 바코드 스캔 지점 |

G2a~G2b 사이가 "동기화 구간"이고, 발견 1의 룰이 없으면 이 구간에서 주소가 갈라진다.
`order-lifecycle-and-refunds.md`의 G2 정의를 이 두 단계로 쪼개야 한다.

### 용어 충돌 — 확인 필요

창고는 *"awaiting shipment에 있지만 실제로 프린트가 시작되지 않은 경우 이미지·주소·shipping 모두
변경해준다"* 고 했다. 그런데 위 폴더 흐름상 `<시설> Awaiting Shipment`는 **생산이 끝난 뒤**다.
둘 중 하나다:

- (a) 창고가 말한 "awaiting shipment"는 **ShipStation의 주문 상태**(라벨 만들기 전 기본 상태)이고,
      OrderDesk 폴더가 아니다
- (b) 창고가 시설 폴더(GA=생산 대기)를 그렇게 부른다

**어느 쪽인지에 따라 G1·G2의 위치가 달라진다.** 창고에 확인해야 한다.

## 발견 3 — 레거시 봇은 이미 실시간 변경 반영을 받고 있다

```
Order Details Changed  → Push Order Details Update to Redis
Order Address Changed  → Push Order Address Update to Redis
Order Item Changed     → Push Item Updates to Redis
Order Note Added       → Push Order Note to Redis

조건: Folder ID in 650227(Job Pool), 665685(QTS), 651474(Proofing),
      652268(Manual Preprocess), 653109(Pending Review),
      657836(To Sales Rep), 661019(Missing/Corrupted File)
```

진행 중인 주문이 바뀌면 OrderDesk가 레거시 봇에 밀어준다.
**우리 AWS 파이프라인에는 이 경로가 없다.** 폴러가 QTS를 한 번 읽어 큐에 넣으면 끝이고,
그 뒤 OrderDesk에서 무엇이 바뀌어도 모른다.

**포팅 누락이며, 수정 자동화의 전제 조건이다.** 다행히 `webhook` Lambda와 공개 라우트가 이미 있으므로
(`POST /webhook/orderdesk`, 공유 시크릿 검증) Redis push 대상 URL을 우리 엔드포인트로 바꾼 룰을
추가하면 된다. 확인 필요: Push 룰이 어디로 쏘는지(엔드포인트 URL).

## 발견 4 — `Order is Imported` 이벤트가 비어 있다

라우팅은 전부 `When Folder is Changed` 기반이고, 조건이 `Folder Name = Today` / `Tomorrow`다.
즉 **오피스가 Today/Tomorrow 폴더에 넣는 행위가 라우팅의 트리거**다.

- 좋은 점: 우리가 계획한 "신규 주문 → Modification Hold" 룰을 `Order is Imported`에 새로 만들면
  **기존 룰과 충돌하지 않는다.** 그 이벤트는 비어 있다.
- 미해결: 주문이 애초에 QTS로 들어가는 경로가 룰에 없다 → **Shopify 통합 설정의 다운로드 폴더**로
  지정돼 있을 것. 해당 설정 화면 확인 필요.

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
| 1 | `Address Change` 룰의 **액션** | 발견 1의 핵심. 이미 ShipStation을 갱신하고 있을 수도 있다 |
| 2 | `update the info to Shipstation` 의 액션 — 주소 필드까지 미는가 | 룰 복제만으로 해결되는지 결정 |
| 3 | `Push ... to Redis` 룰의 **대상 엔드포인트 URL** | 우리 webhook으로 돌릴 수 있는지 |
| 4 | Shopify 통합 설정 — 다운로드 폴더 / financial status / fulfillment status | 주문이 QTS로 들어가는 경로 |
| 5 | 창고의 "awaiting shipment"가 OrderDesk 폴더인가 ShipStation 상태인가 | G1·G2 위치 |
| 6 | `(New Site)` / `(Copy)` 중복 룰 — 둘 다 도는가 | 룰 추가 전 정리 필요 |
| 7 | CA·NV의 라벨 출력 경로 | ShipStation store id가 없다 |
| 8 | MT가 실제로 어디로 가는가 (실주문 확인) | 불일치 1번 |
