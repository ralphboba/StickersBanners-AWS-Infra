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
  readonly userPool: cognito.IUserPool;
  readonly userPoolClient: cognito.IUserPoolClient;
}

/**
 * HTTP API front door (Week 6).
 *
 * Two routes with deliberately different auth:
 *   POST /webhook/orderdesk  — called by OrderDesk; it can't hold a Cognito
 *                              JWT, so the webhook Lambda validates a shared
 *                              secret header itself (route is unauthenticated
 *                              at the gateway).
 *   GET  /orders/{name}      — staff/web; protected by a Cognito JWT authorizer.
 *
 * HTTP API (not REST API) — cheaper and free up to 1M requests/month => $0.
 */
export class ApiStack extends cdk.Stack {
  public readonly httpApi: apigw.HttpApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const { config, webhookFn, orderApiFn, approvalFn, userPool, userPoolClient } = props;

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

    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: this.httpApi.apiEndpoint,
      description: 'Base URL of the HTTP API',
      exportName: `${config.prefix}-api-endpoint`,
    });
  }
}
