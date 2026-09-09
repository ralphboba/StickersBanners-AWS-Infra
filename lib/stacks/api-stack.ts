import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { EnvironmentConfig } from '../config/types';

export interface ApiStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
  /** OrderDesk push receiver (public route, validates its own shared secret). */
  readonly webhookFn: lambda.IFunction;
  /** Read-only order status lookups (protected by Cognito JWT). */
  readonly orderApiFn: lambda.IFunction;
  /** Proof approve/reject — resumes the paused pipeline (Cognito JWT). */
  readonly approvalFn: lambda.IFunction;
  /** Customer proof approval (public route; the signed link is the credential). */
  readonly proofApprovalFn: lambda.IFunction;
  readonly userPool: cognito.IUserPool;
  readonly userPoolClient: cognito.IUserPoolClient;
}

/**
 * HTTP API front door (Week 6).
 *
 * Routes with deliberately different auth:
 *   POST /webhook/orderdesk  — called by OrderDesk; it can't hold a Cognito
 *                              JWT, so the webhook Lambda validates a shared
 *                              secret header itself (route is unauthenticated
 *                              at the gateway).
 *   GET  /orders/{name}      — staff/web; protected by a Cognito JWT authorizer.
 *   GET/POST /proof*         — the customer; no JWT (they have no account), the
 *                              signed link from the proof email is the credential.
 *
 * HTTP API (not REST API) — cheaper and free up to 1M requests/month => $0.
 */
export class ApiStack extends cdk.Stack {
  public readonly httpApi: apigw.HttpApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const { config, webhookFn, orderApiFn, approvalFn, proofApprovalFn, userPool, userPoolClient } = props;

    this.httpApi = new apigw.HttpApi(this, 'HttpApi', {
      apiName: `${config.prefix}-api`,
      description: `StickersBanners HTTP API (${config.env})`,
      // CORS for the staff dashboard (web/index.html). Tighten allowOrigins to
      // the real dashboard origin once it has a fixed URL.
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.POST],
        allowHeaders: ['authorization', 'content-type'],
        maxAge: cdk.Duration.hours(1),
      },
    });

    // Public webhook route — auth handled inside the Lambda (shared secret).
    this.httpApi.addRoutes({
      path: '/webhook/orderdesk',
      methods: [apigw.HttpMethod.POST],
      integration: new HttpLambdaIntegration('WebhookIntegration', webhookFn),
    });

    // Protected status route — Cognito JWT required.
    const authorizer = new HttpUserPoolAuthorizer('CognitoAuthorizer', userPool, {
      userPoolClients: [userPoolClient],
    });
    const orderApiIntegration = new HttpLambdaIntegration('OrderApiIntegration', orderApiFn);
    // List orders by status (dashboard) + single-order lookup.
    this.httpApi.addRoutes({
      path: '/orders',
      methods: [apigw.HttpMethod.GET],
      integration: orderApiIntegration,
      authorizer,
    });
    this.httpApi.addRoutes({
      path: '/orders/{name}',
      methods: [apigw.HttpMethod.GET],
      integration: orderApiIntegration,
      authorizer,
    });
    // Demo-only manual move between folders (handler hard-guards to DEMO-*/ZZ-*).
    this.httpApi.addRoutes({
      path: '/orders/{name}/move',
      methods: [apigw.HttpMethod.POST],
      integration: orderApiIntegration,
      authorizer,
    });

    // Proof review: separate approve/reject routes (clear intent + room for
    // per-route authorization later). Both resume the paused pipeline.
    const approvalIntegration = new HttpLambdaIntegration('ApprovalIntegration', approvalFn);
    for (const action of ['approve', 'reject']) {
      this.httpApi.addRoutes({
        path: `/orders/{name}/${action}`,
        methods: [apigw.HttpMethod.POST],
        integration: approvalIntegration,
        authorizer,
      });
    }

    // Customer proof approval — PUBLIC on purpose.
    //
    // Customers have never had an account (Linh's portal is the only thing they
    // see), so a Cognito authorizer here would mean nobody outside the company
    // could ever approve a proof. The credential is the signed, expiring,
    // single-order token in the proof email, checked inside the Lambda — the
    // same shape as the webhook route above.
    //
    // Only these two route keys exist. There is no customer reject and no
    // customer upload: the staff-only POST /orders/{name}/reject above stays
    // behind Cognito, and no upload route exists anywhere in the API.
    const proofIntegration = new HttpLambdaIntegration('ProofApprovalIntegration', proofApprovalFn);
    this.httpApi.addRoutes({
      path: '/proof',
      methods: [apigw.HttpMethod.GET],
      integration: proofIntegration,
    });
    this.httpApi.addRoutes({
      path: '/proof/approve',
      methods: [apigw.HttpMethod.POST],
      integration: proofIntegration,
    });

    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: this.httpApi.apiEndpoint,
      description: 'Base URL of the HTTP API',
      exportName: `${config.prefix}-api-endpoint`,
    });
  }
}
