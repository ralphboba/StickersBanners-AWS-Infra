# Shopify → OrderDesk 보강 Lambda (외부 코드) — 읽기 노트

Kai가 공유한 AWS Lambda의 분석. **이 리포에 없는 코드**지만 주문이 QTS로 들어가는
경로 전체를 이 함수가 쥐고 있어서, 두 프로젝트(주문 수정 자동화 / 공장 프로그램)의
착수 지점이 여기다.

## 무엇을 하는가

```
Shopify ──웹훅?──▶ S3  s3://stickersbanners-shopify-orders-raw
                        orders/YYYY/MM/DD/<ORDERNAME>_order_*.json
                          │  (S3 ObjectCreated 이벤트)
                          ▼
                   ★ 이 Lambda
                     1. OrderDesk에서 해당 주문을 찾는다  (만들지 않는다)
                     2. PUT — variation_list 전면 교체 + ZIP 정규화 + 노트 추가
                     3. move-orders — 목적지 폴더로 이동
                          │
                          ▼
                   QTS 665685  /  QTS - Pay By Check 698334
                   Flag Banner  /  B2SIGN
```

**주문 자체는 OrderDesk의 Shopify 연동이 먼저 만든다.** 이 Lambda는 그것을 찾아
보강하고 옮긴다 — `findOrderDeskOrderIdWithRetry`가 "OrderDesk order not found yet"으로
5회 재시도(2s→15s)하는 것이 그 레이스를 견디기 위한 장치다.

### 주문 찾기 (3단 폴백)

1. `orders?search=<shopify_order_id>` → 후보 12건까지 상세 조회 →
   `order_metadata.shopify_order_id` 일치
2. `orders?source_id=<ORDERNAME>` → 유일하면 채택, 아니면 상세로 정확 일치
3. `orders?search=<ORDERNAME>` → `source_id` 또는 `order_number` 일치.
   **2건 이상이면 거부**("Ambiguous match. Refusing.")하고 재시도도 안 한다

### 목적지 폴더 결정 (`getDestinationFolder`)

| 조건 | 폴더 |
| --- | --- |
| 품목명에 `flag` 포함 | `Flag Banner` |
| B2SIGN 품목 (canvas wrap, yard sign, 10/15ft tent·walls) | `B2SIGN` |
| `payment_gateway_names`에 `pay by check` | `QTS - Pay By Check` |
| 그 외 | `QTS` |

### 멱등성

`order_notes`에 `sha256=<앞12자>`가 이미 있으면 통째로 건너뛴다(PUT도 이동도 안 함).
**같은 S3 객체의 재전달은 무해하지만, 페이로드가 달라지면(=주문이 수정되면) 다시 실행된다.**

## 수정 창(Modification Window)이 들어갈 자리

**`getDestinationFolder` 한 곳이다.** 수정 창이 열려 있는 동안 `QTS`를 반환하지 않으면
주문은 봇에게 보이지 않는다.

`docs/order-lifecycle-and-refunds.md`의 D3(“신규 주문을 Hold 폴더로 보내는 OrderDesk 룰”)은
**폐기해도 된다.** 새 폴더도, `Order is Imported` 룰도, 시간 기반 릴리스 룰도 필요 없다.
창이 닫힐 때 이 Lambda(또는 별도 릴리스 경로)가 `moveToFolder`를 호출하면 그만이다.

## 수정 창을 열기 전에 고쳐야 할 것 3가지

### H1. 폴더 이동에 가드가 없다 — 생산 중인 주문이 QTS로 끌려온다

`moveToFolder`는 주문이 **지금 어느 폴더에 있는지 보지 않는다.** 주문이 수정되어 새 S3 객체가
생기면 sha가 달라지므로 멱등성 검사를 통과하고, PUT 후 무조건 `QTS`로 이동한다.

이미 `GA`(생산) 또는 `GA Awaiting Shipment`에 있던 주문이 **QTS로 되돌아간다.**
지금은 주문당 사실상 1회만 실행되어 잘 드러나지 않지만, **수정 창을 열면 상시 발생한다.**

> 수정: 이동 전에 현재 폴더를 읽고, QTS 이전 단계일 때만 옮긴다.
> 그 판정이 곧 G1 게이트다.

### H2. PUT이 주문 레코드 전체를 덮어쓴다 (lost update)

```js
const updatePayload = { ...odOrder, order_items: updatedOrderItems, ... };
```

`odOrder`는 이 실행 시작 시점에 읽은 사본이다. 그 사이 오피스가 OrderDesk에서 무언가
고쳤다면 되돌아간다. `order_items`는 아예 전면 교체다.

수정 창을 열면 "고객이 Shopify에서 수정" 과 "오피스가 OrderDesk에서 수정"이 겹치는
구간이 생기므로 정면으로 부딪힌다.

> 수정: 변경 필드만 PATCH하거나, PUT 직전에 재조회해 병합한다.

### H3. 주소는 ZIP만 동기화한다 ★ 주소 변경 프로젝트의 핵심

```js
function buildUpdatedAddresses({ odOrder, transformed }) {
  ... updated.customer  = { ...odOrder.customer, postal_code: billingZip };
      updated.shipping  = { ...odOrder.shipping, postal_code: shippingZip };
}
```

`postal_code`만 세팅한다. **street / city / state / name은 Shopify에서 가져오지 않는다.**
(원래 목적이 ZIP+4를 5자리로 정규화해 라우팅 룰에 맞추는 것이므로 그 자체는 맞다.)

문제는 이것이다 — 고객이 Shopify에서 주소를 통째로 바꾸면 **ZIP만 갱신되고 나머지는 옛 주소로
남는다.** 새 ZIP + 옛 거리 주소라는 최악의 조합이 만들어진다. 지금도 잠재 위험이고,
주소 변경 기능을 열면 상시 발생한다.

> 수정: 여기를 **전체 배송 주소**로 확장한다. 그러면 OrderDesk의 `Address Change` 룰
> (액션 `Submit Order to ShipStation`, 필터 없음)이 **ShipStation까지 자동으로 전파한다** —
> `docs/orderdesk-rules-audit.md` 발견 1 참조.
>
> **즉 "Change Address 버튼" 프로젝트의 백엔드는 이 함수 하나를 넓히는 일이다.**
> ShipStation API를 직접 칠 필요가 없다.

## 이 리포 쪽의 실제 버그 — `UPLOADED FILE` 대소문자 불일치

Lambda가 쓰는 키:

```js
variation_list["UPLOADED FILE"]        = ...   // 단일
variation_list[`UPLOADED FILE ${i+1}`] = ...   // 다중 (모두 대문자)
```

`src/shared/orderdesk.mjs`의 `collectArtwork`가 읽는 키:

```js
const fileLink = vl?.['Uploaded File'] || vl?.['UPLOADED FILE'];   // 단일 — 양쪽 OK
if (!fileLink) {
  if (vl?.['Uploaded File 1']) return { ...none, hasMultipleFiles: true };  // ← 타이틀케이스만
  return { ...none, isMissingFile: true };
}
```

**단일 키는 두 표기를 다 받는데 다중 키는 타이틀케이스만 본다.** 실제 생산자는 대문자로 쓴다.

결과: 파일이 여러 개인 주문에서 `UPLOADED FILE`(단일)이 없고 `UPLOADED FILE 1`만 있으면
`hasMultipleFiles`가 아니라 **`isMissingFile`로 잘못 분류**된다. 인테이크 게이트에서
Yellow → `sales`(파일이 여러 개니 사람이 고르라)가 아니라 Red → `manual`(파일이 없다)로 가고,
스태프가 엉뚱한 큐에서 "파일 없음"으로 보게 된다.

> 수정: 다중 검사도 `vl['Uploaded File 1'] || vl['UPLOADED FILE 1']`로.
> 레거시 동작 변경이 아니라 **레거시 의도대로 되게 하는 수정**이므로 Linh 확인 대상이 아니다.

## 그 밖에 눈에 띈 것

- **`shouldSplit` 조건이 자기 주석과 다르다.** 주석은 "qty=1 + 파일 N개(번들)도 분리"라고
  적혀 있는데 실제 조건은 `uploadedFiles.length === quantity && quantity > 1`이라
  **qty=1 케이스가 빠져 있다.** 그런 주문은 분리되지 않고 `UPLOADED FILE 1..N`으로 한 줄에
  남으며, 위 버그와 겹쳐 `missing file`로 떨어진다.
- **`moveToFolder` 실패가 non-fatal로 삼켜진다.** 폴더를 **이름 문자열**로 지정하는데
  (`destination_folder_name`), Kai가 보내준 폴더 목록에 `Flag Banner` / `B2SIGN`이라는
  이름은 보이지 않는다(`B2S Order`, `Approved Flag Banner` 등은 있음). 이름이 틀리면
  **주문이 조용히 안 옮겨진다.** 확인 필요.
- **노트가 매 실행마다 쌓인다.** 멱등성 검사가 노트 스캔이므로 수정이 잦아지면 노트가
  길어지고 검사도 느려진다.
- `Ambiguous match. Refusing.`은 재시도 대상에서 제외되어 **조용히 누락**된다.
  로그에만 남는다.

## 아직 모르는 것

| # | 내용 | 왜 중요한가 |
| --- | --- | --- |
| 1 | **S3에 쓰는 상류 코드는 무엇인가** (Shopify 웹훅 수신자) | 이 Lambda는 S3 이벤트로만 뜬다 |
| 2 | 이 Lambda의 코드베이스 / 배포 경로 | 우리가 고칠 수 있는지 |
| 3 | `Flag Banner` · `B2SIGN` 폴더가 실제로 존재하는지 | 조용한 이동 실패 |

## ★ Kai 확인: 이 경로는 신규 주문에서만 돈다

S3 객체는 **주문이 새로 생길 때만** 써진다. 주문이 *수정*되어도 새 객체는 생기지 않고,
따라서 이 Lambda도 뜨지 않는다.

### 그래서 수정 전파 체인이 첫 칸에서 끊긴다

```
Shopify에서 주소 변경
   ✂  S3에 안 써짐 → Lambda 안 뜸 → OrderDesk 갱신 안 됨
      → Order Address Changed 이벤트 안 뜸
      → Submit Order to ShipStation 안 뜸
      → ShipStation은 옛 주소 그대로
```

`docs/orderdesk-rules-audit.md` 발견 1의 룰들은 전부 정상인데, **아무도 그 방아쇠를 당기지
않는다.**

### 지금 운영이 굴러가는 이유

오피스가 **Shopify가 아니라 OrderDesk에서 직접** 고치기 때문이다. OrderDesk에서 주소를 바꾸면
`Order Address Changed`가 발화하고 ShipStation까지 정상 전파된다.

**즉 현장의 사실상 진실은 Shopify가 아니라 OrderDesk다.** 대신 Shopify 주문 레코드는
옛 주소로 남아 둘이 갈라져 있다.

### 설계에 주는 결론

수정 사항을 `orders/updated` 웹훅 → S3 → 이 Lambda 체인에 태우지 **않는다.**
부품이 다섯이고 각각이 실패 지점이며, 이 Lambda에는 아래 H1·H2·H3가 있다.

대신 **우리 수정 서비스가 두 시스템에 직접 쓴다**:

| 대상 | 무엇을 | 왜 |
| --- | --- | --- |
| **OrderDesk** | 주소·배송방법·라인아이템 | 운영을 실제로 움직이는 곳. 쓰는 순간 기존 룰이 ShipStation·레거시 봇까지 전파 |
| **Shopify** | 차액 인보이스, 주문 기록 | 돈과 고객 조회의 진실 |

순서는 OrderDesk 먼저(운영이 급하다), Shopify는 그 다음.

**부수 효과 — H1·H2·H3를 고칠 필요가 없어진다.** 셋 다 "수정분이 이 Lambda를 다시 탈 때"만
문제가 되는데, 그렇게 태우지 않기로 했기 때문이다. 이 Lambda에서 손댈 곳은
`getDestinationFolder`의 수정 창 홀드 하나뿐이고, 아래 대안을 택하면 그것마저 없다.
