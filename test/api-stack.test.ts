import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { getConfig } from '../lib/config/environments';
import { ApiStack } from '../lib/stacks/api-stack';

function synth(envName: 'dev' | 'prod' = 'dev') {
  const app = new cdk.App();
  const config = getConfig(envName);
  const deps = new cdk.Stack(app, 'deps', {
    env: { account: '123456789012', region: config.region },
  });
  const fn = (id: string) =>
    new lambda.Function(deps, id, {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => ({});'),
    });
  const userPool = new cognito.UserPool(deps, 'Pool');
  const userPoolClient = userPool.addClient('Client');

  const stack = new ApiStack(app, `${config.prefix}-api`, {
    config,
    env: { account: '123456789012', region: config.region },
    webhookFn: fn('Webhook'),
    orderApiFn: fn('OrderApi'),
    approvalFn: fn('Approval'),
    userPool,
    userPoolClient,
  });
  return Template.fromStack(stack);
}

describe('ApiStack', () => {
  test('creates one HTTP API with exactly the expected routes', () => {
    const template = synth();
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    // Asserting the route keys rather than a count: a bare count goes stale
    // silently every time a route is added, and says nothing about which.
    const keys = Object.values(template.findResources('AWS::ApiGatewayV2::Route'))
      .map((r) => r.Properties.RouteKey)
      .sort();
    expect(keys).toEqual([
      'GET /orders',
      'GET /orders/{name}',
      'POST /orders/{name}/approve',
      'POST /orders/{name}/move',
      'POST /orders/{name}/reject',
      'POST /webhook/orderdesk',
    ]);
  });

  test('orders list route exists and requires auth', () => {
    const template = synth();
    const routes = template.findResources('AWS::ApiGatewayV2::Route');
    const byKey = Object.fromEntries(
      Object.values(routes).map((r) => [r.Properties.RouteKey, r.Properties]),
    );
    expect(byKey['GET /orders'].AuthorizationType).toBe('JWT');
  });

  test('CORS is enabled for the dashboard', () => {
    synth().hasResourceProperties('AWS::ApiGatewayV2::Api', {
      CorsConfiguration: Match.objectLike({
        AllowMethods: Match.arrayWith(['GET', 'POST']),
      }),
    });
  });

  test('approve and reject routes exist and require auth', () => {
    const template = synth();
    const routes = template.findResources('AWS::ApiGatewayV2::Route');
    const byKey = Object.fromEntries(
      Object.values(routes).map((r) => [r.Properties.RouteKey, r.Properties]),
    );
    expect(byKey['POST /orders/{name}/approve'].AuthorizationType).toBe('JWT');
    expect(byKey['POST /orders/{name}/reject'].AuthorizationType).toBe('JWT');
  });

  test('has a JWT (Cognito) authorizer', () => {
    synth().hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
      AuthorizerType: 'JWT',
    });
  });

  test('webhook route is public; orders route requires the authorizer', () => {
    const template = synth();
    const routes = template.findResources('AWS::ApiGatewayV2::Route');
    const byKey = Object.fromEntries(
      Object.values(routes).map((r) => [r.Properties.RouteKey, r.Properties]),
    );
    expect(byKey['POST /webhook/orderdesk'].AuthorizationType ?? 'NONE').toBe('NONE');
    expect(byKey['GET /orders/{name}'].AuthorizationType).toBe('JWT');
  });

  test('routes integrate with a Lambda', () => {
    const template = synth();
    // webhook + order-api + one shared approval integration (approve & reject)
    template.resourceCountIs('AWS::ApiGatewayV2::Integration', 3);
    for (const i of Object.values(template.findResources('AWS::ApiGatewayV2::Integration'))) {
      expect(i.Properties.IntegrationType).toBe('AWS_PROXY');
    }
  });
});
