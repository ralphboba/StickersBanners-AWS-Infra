# 배송 변경 실주문 테스트 — Kai의 Mac에서 AWS 배포 (S64262)

목표: 주문 확인 메일의 **Manage my order** 버튼 → 배송 업그레이드 → 인보이스 결제 → Shopify가
보내는 **진짜 결제 알림** → OrderDesk 반영 → Google Chat. 모든 메일은 kai@stickersbanners.com
(S64262의 주문 이메일을 kai@으로 바꿔 둠).

배포 범위는 이 기능에 필요한 것만: `sb-billing`(비용 알림) + `sb-dev-webapp`과 그 의존 스택
(database, queues, cdn, compute, auth, api). ECS·network·scheduler는 배포하지 않는다(비용, 그리고
scheduler의 미러가 실제 OrderDesk/Shopify를 주기적으로 읽기 때문).

쓰기 스위치는 `--context testOrders=S64262`를 줄 때만, **S64262에만** 켜진다(`WRITE_ONLY_ORDERS`,
`write-gates.mjs`). 이 값 없이 다시 배포하면 전부 꺼진다.

## 0. 도구 (한 번)

```bash
brew install node awscli git
aws configure                 # Access key, Secret, region us-east-1, output json
aws sts get-caller-identity   # Account 번호가 나오면 OK
```

## 1. 코드 받기

```bash
git clone -b claude/order-modification-automation-li1gja https://github.com/ralphboba/StickersBanners-AWS-Infra.git
cd StickersBanners-AWS-Infra
npm ci
```

## 2. CDK 준비 (계정·리전당 한 번)

```bash
npx cdk bootstrap --context env=dev
```

## 3. 비밀값을 SSM에 (값은 채팅에 붙여넣지 않는다)

```bash
cp scripts/parameters.example.env scripts/parameters.dev.env
open -e scripts/parameters.dev.env
# ORDERDESK_API_KEY, ORDERDESK_STORE_ID, SHOPIFY_CLIENT_SECRET, GCHAT_WEBHOOK_URL 채우기
scripts/seed-parameters.sh dev
```

## 4. 배포

```bash
npx cdk deploy sb-billing sb-dev-webapp --context env=dev --context testOrders=S64262
```

권한 변경 확인(`Do you wish to deploy these changes (y/n)?`)에 `y`. 끝나면 출력에서 두 값을 적어 둔다:
- `sb-dev-api.ApiEndpoint` — 예: `https://abc123.execute-api.us-east-1.amazonaws.com`
- `sb-dev-webapp.MyOrderUrl` — 예: `https://d1234.cloudfront.net/my-order`

## 5. S64262를 페이지에 올리기

```bash
node scripts/seed-test-row.mjs S64262
```

## 6. Shopify 결제 알림 연결 (S64262만)

```bash
node scripts/shopify-webhooks.mjs add --url <ApiEndpoint>/webhook/shopify-paid --order S64262
node scripts/shopify-webhooks.mjs list
```

## 7. 메일 버튼 (S64262에게만 보이게)

Shopify 관리자 → Settings → Notifications → Order confirmation → Edit code. `shopify-email-button.md`의
위치에 아래를 붙인다. `{% if order_name == 'S64262' or order_name == '#S64262' %}` 덕분에 **실제 고객 메일에는 아무것도 바뀌지
않는다.** `<MyOrderUrl>`은 4단계 값.

```liquid
{% if order_name == 'S64262' or order_name == '#S64262' %}
  <table cellpadding="0" cellspacing="0" border="0" style="margin-top:16px;">
    <tr>
      <td align="center" style="border:1px solid {{ shop.email_accent_color }}; border-radius:4px; padding:11px 22px;">
        <a href="<MyOrderUrl>?o={{ order_name | remove: '#' | url_encode }}&amp;s={{ order_status_url | url_encode }}"
           style="display:inline-block; font-size:16px; font-weight:600; text-decoration:none; color:{{ shop.email_accent_color }};">Manage my order</a>
      </td>
    </tr>
  </table>
{% endif %}
```

## 8. 테스트

1. S64262 → 타임라인의 Order confirmation → **Resend** (받는 사람 kai@ 확인).
2. 메일의 **Manage my order** → FedEx 3-Days → **Send me the invoice**.
3. kai@로 온 인보이스로 결제 (또는 관리자에서 Mark as paid — 같은 결제 알림이 간다).
4. OrderDesk S64262가 FedEx 3-Days로 바뀌고 Google Chat에 한 줄이 오면 성공.

로그: `aws logs tail /aws/lambda/sb-dev-shopify-paid --follow`

## 9. 끝나면

```bash
node scripts/shopify-webhooks.mjs remove
npx cdk deploy sb-dev-webapp --context env=dev      # testOrders 없이 → 쓰기 스위치 전부 off
```
템플릿의 `{% if order_name == 'S64262' or order_name == '#S64262' %}` 블록은 지워도 되고 둬도 된다(S64262 외엔 안 보임).
S64262 원상복구는 Claude에게 요청.
