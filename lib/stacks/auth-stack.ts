import * as cdk from 'aws-cdk-lib/core';
import { Duration, RemovalPolicy } from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { EnvironmentConfig } from '../config/types';

export interface AuthStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
}

/**
 * Cognito authentication (Week 6).
 *
 * Replaces the legacy bcrypt + Redis-session login. A User Pool holds staff
 * accounts; the App Client issues JWTs that the API Gateway authorizer
 * verifies. Self-signup is disabled — this is an internal tool, so admins
 * create accounts. Free up to 50,000 monthly active users, so it stays at $0.
 */
export class AuthStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    const { config } = props;
    const isProd = config.env === 'prod';

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${config.prefix}-users`,
      selfSignUpEnabled: false, // admins create staff accounts
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: Duration.days(3),
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      // Keep the staff directory on prod stack deletion; dev is disposable.
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    // Public client (no secret) for browser/SPA auth; short-lived access tokens.
    this.userPoolClient = this.userPool.addClient('WebClient', {
      userPoolClientName: `${config.prefix}-web`,
      generateSecret: false,
      // userPassword: lets the dashboard log in with a plain fetch call (no SDK
      // bundle). Credentials only ever travel over HTTPS to Cognito.
      authFlows: { userSrp: true, userPassword: true },
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
      preventUserExistenceErrors: true,
    });

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      exportName: `${config.prefix}-user-pool-id`,
    });
    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
      exportName: `${config.prefix}-user-pool-client-id`,
    });
  }
}
