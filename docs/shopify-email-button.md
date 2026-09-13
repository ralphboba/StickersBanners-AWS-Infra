# 주문 확인 메일에 "Manage my order" 버튼 넣기

Kai가 공유한 **실제** Order confirmation 알림 템플릿(Shopify 기본 템플릿 + 스토어 커스터마이즈)을
읽고 정리한 것. 붙여넣을 Liquid와 붙일 위치, 그리고 템플릿을 읽으면서 확정된 것들.

편집 위치: Shopify 관리자 → **Settings → Notifications → Order confirmation**.

## 템플릿을 읽고 확정된 것 3가지

### 1. 토큰 문제가 해결된다 — `order_status_url`이 이미 있다

설계안(`order-mod-plan.html`)에는 "HMAC 서명 링크"로 적어놨지만 **Liquid는 HMAC을 계산할 수
없다.** 대신 이 템플릿에는 이미 `{{ order_status_url }}`이 들어 있다:

```liquid
<a href="{{ order_status_url }}" class="button__text">View your order</a>
```

이 URL 안에는 Shopify가 발급한 추측 불가능한 주문 토큰이 들어 있고, 주문당 영구적이다.
**그걸 그대로 우리 페이지에 넘기면 별도 서명 체계가 필요 없다.** 보안 수준은 Shopify 주문상태
페이지와 동일해진다(= 링크를 가진 사람만 접근).

URL 형식은 스토어/버전마다 다를 수 있으므로 **토큰만 잘라내지 말고 URL 통째로 인코딩해서
넘기고, 파싱은 서버에서 한다.** 형식이 바뀌어도 링크가 깨지지 않는다.

### 2. 버튼 색은 이미 정해져 있다 — 물어볼 필요 없음

템플릿 `<head>`에:

```liquid
.button__cell { background: {{ shop.email_accent_color }}; }
a, a:hover, a:active, a:visited { color: {{ shop.email_accent_color }}; }
```

브랜드 색은 **Shopify 브랜딩 설정에서 이미 관리되고 있다.** 목업 리뷰 항목에서 "brand colour
hex"는 빼도 된다. 우리 버튼도 `{{ shop.email_accent_color }}`를 쓰면 자동으로 맞는다.

### 3. 버튼 블록이 3갈래여서, 안이 아니라 **뒤에** 붙여야 한다

`{% if order_status_url %}` 안이 이렇게 갈린다:

| 분기 | 조건 |
| --- | --- |
| A | `shop_app_tracking_button_variant_key == "track_with_shop"` — View your order + Track with Shop |
| B | 그 외 `shop_app_tracking_url` 있음 — View your order + Download to track |
| C | `shop_app_tracking_url` 없음 — View your order 단독 |

세 갈래 중 하나에만 넣으면 **어떤 고객에게는 버튼이 안 보인다.** 그래서 세 갈래를 감싸는
`{% endif %}` **바깥**에 독립 블록으로 붙인다. 편집 한 군데로 전 케이스가 커버된다.

## 붙일 위치

템플릿에서 이 지점을 찾는다 — content 섹션의 버튼 블록이 끝나고 `</td>`로 닫히기 직전:

```liquid
            {% else %}
              {% if shop.url %}
    <table class="row actions">
      ...
    </table>
{% endif %}

            {% endif %}
                                    ← ★ 여기
            </td>
          </tr>
        </table>
      </center>
```

`{% endif %}` 다음 줄, `</td>` 앞이다.

## 붙여넣을 Liquid

```liquid
{% comment %} SB — self-service order management (shipping upgrade / add-ons) {% endcomment %}
{% if order_status_url and has_pending_payment != true %}
  <table class="row actions" cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td class="actions__cell">
        <p style="margin:0 0 12px 0; font-size:14px; line-height:20px; color:#6b6b6b;">
          Need it sooner? You can upgrade your shipping yourself — no phone call needed.
        </p>
        <table cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td align="center"
                style="border:1px solid {{ shop.email_accent_color }}; border-radius:4px; padding:11px 22px;">
              <a href="https://proof.stickersbanners.com/my-order?o={{ order_name | remove: '#' | url_encode }}&amp;s={{ order_status_url | url_encode }}"
                 style="display:inline-block; font-size:16px; font-weight:600; text-decoration:none; color:{{ shop.email_accent_color }};">Manage my order</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
{% endif %}
```

### 왜 이렇게 썼는지

| 결정 | 이유 |
| --- | --- |
| **아웃라인 버튼** (배경 없음, 테두리만) | 바로 위 "View your order"가 이미 꽉 찬 accent 버튼이다. 같은 스타일로 두 개면 뭐가 주(主)인지 안 보인다. 추적은 Shopify, 수정은 우리 — 역할이 갈리므로 위계도 갈라준다 |
| 인라인 스타일 | `styles.css`에 아웃라인 버튼 클래스가 없다. 링크할 수 없으니 인라인으로 |
| `table` 기반 | Outlook은 `div` + `padding` 버튼을 제대로 못 그린다. 기존 템플릿도 전부 테이블이다 |
| `has_pending_payment != true` | 결제 대기(Pay by Check 등) 주문은 아직 확정 전이다. 업그레이드를 붙일 잔액 자체가 확정이 아니라 제외 |
| `order_name \| remove: '#'` | `#S59131` → `S59131`. 우리 `orderName`과 표기를 맞춘다 |
| `order_status_url \| url_encode` **통째로** | 위 §1 참조. 형식 변화에 안 깨진다 |
| `&amp;` | Liquid가 아니라 HTML 이슈. 메일 클라이언트에서 `&`를 그대로 두면 일부가 엔티티로 잘못 파싱한다 |

## 서버 쪽 계약

`/my-order`가 받는 것:

```
GET /my-order?o=S59131&s=<url-encoded order_status_url>
```

검증 순서:

1. `s`를 디코드해 Shopify 주문상태 URL인지 확인(호스트 화이트리스트)
2. 그 안의 토큰을 뽑아 **우리 DB에 저장된 주문의 토큰과 대조** — 일치해야 통과
3. `o`는 표시용 겸 보조 확인. `o`만으로는 절대 통과시키지 않는다(주문번호는 순번이라 추측된다)

→ **선행 작업:** 주문 인테이크 시점에 `order_status_url`을 저장해야 한다. 지금은 저장하지
않는다. Phase 02(`order-stage.mjs`)에 이 필드 확보를 포함시킨다.

## 픽업 주문은?

이 템플릿은 픽업 주문에도 같이 쓰인다(`delivery_method == 'pick-up'` 분기 존재). 버튼은
그대로 두는 게 맞다 — 픽업↔배송 전환이 원래 범위에 있었고, 페이지가 알아서 픽업용 옵션을
보여주면 된다. 배송 업그레이드만 하고 끝낼 거면 `{% if requires_shipping %}` 조건을 추가한다.

## 배포 순서 (되돌리기 쉬운 순으로)

1. **Preview**로 렌더 확인 (Notifications 편집기 우측 상단)
2. **Send test email** — Gmail 웹 / Gmail 앱 / Outlook / iOS Mail 4곳
3. 실제 주문 1건으로 확인
4. 문제 있으면 스니펫만 지우면 원복 — 기존 코드를 건드리지 않는 순수 추가라 위험이 없다

**주의:** 링크 도착지(`proof.stickersbanners.com/my-order`)가 살아있기 전에 버튼부터 넣으면
고객이 404를 본다. **페이지가 뜬 다음에 템플릿을 편집한다.**

## 덤 — 템플릿에서 눈에 띈 것

Shopify 기본 템플릿에 이런 줄이 여러 군데 있다:

```liquid
{% if line.quantity < line.quantity %}
```

**자기 자신과 비교하므로 항상 거짓이다.** "3 of 5" 같은 부분 수량 표시가 절대 안 나온다는 뜻.
Shopify 기본 코드라 우리가 만든 게 아니고, 부분 이행을 안 쓰는 우리 운영에는 영향이 없다.
건드릴 필요 없고, 나중에 부분 이행을 쓰게 되면 이 줄을 떠올리면 된다.

---

## 실제 렌더 확인 (Kai 스크린샷)

Preview로 실제 발송 화면을 확인한 결과, 위 판단 중 하나가 **더 강해지고** 하나가 **새 문제로 드러났다.**

### 확인된 것 — 3갈래 중 A/B 분기가 실제로 작동 중이다

렌더에 **`Track order with shop`(보라색) 버튼이 있다.** 즉 이 스토어는
`shop_app_tracking_url`이 붙는 분기를 타고 있고, 두 버튼이 **50/50 전폭**으로 나란히 서고
`or Visit our store`가 그 아래 가운데 정렬된다.

→ "`{% endif %}` **바깥**에 붙인다"는 결정이 맞았다는 확인. 만약 마지막 단독 버튼 분기(C)
안에 넣었다면 **지금 고객 아무에게도 안 보였을 것이다.**

### 확인된 것 — accent 색은 초록이다

`shop.email_accent_color`가 **짙은 초록**(≈`#146B4F`)이다. `View your order` 버튼과
`Visit our store` 링크가 그 색이다. 보라색은 Shopify Shop 앱 고정색이라 우리가 못 바꾼다.

우리 아웃라인 버튼은 자동으로 같은 초록 테두리가 되므로 **추가 설정이 없다.**

### 새 문제 — 버튼이 세 개가 된다

```
[  View your order  ][ Track order with shop ]   ← 이미 전폭 2개
            or Visit our store
[      Manage my order (아웃라인)      ]         ← 우리가 추가
```

초록 채움 + 보라 채움 + 초록 테두리. **버튼 영역이 무거워진다.**

| 안 | 내용 | 평가 |
| --- | --- | --- |
| **A. 지금처럼 아래에 추가** | 아웃라인이라 위계는 확실히 아래 | 발견율 최고. 대신 버튼 셋 |
| **B. Order summary 아래로 이동** | 주문 내용을 다시 보는 위치에 배치 | 버튼 뭉침 해소. 스크롤해야 보임 |
| C. `or Visit our store` 줄에 텍스트 링크로 | 가장 가벼움 | **발견이 안 된다.** 전화가 안 줄어들면 프로젝트 자체가 무의미 |

A로 시작하되 **폰에서 실물을 보고 판단**하는 걸 권한다. C는 배제.

### 덤 — 픽업 주문의 레이아웃이 다르다

스크린샷은 픽업 주문이라 본문이 `You'll receive an email when your order is ready for pickup.`
이고, 픽업+배송이 섞여서 `has_split_cart`가 켜지며 **Order summary가 `Shipping items`
그룹으로 쪼개지고 `Estimated delivery`가 붙는다.**

버튼 위치(버튼 블록 뒤)는 이 분기의 **위쪽**이라 영향받지 않는다. 다만 안 B(Order summary
아래로 이동)를 택하면 **쪼개진 그룹 사이에 끼는 경우를 확인해야 한다.**
